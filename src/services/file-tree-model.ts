/**
 * File tree model — the workspace file/selection state backing the sidebar
 * webview (see `src/ui/webview-host-bridge.ts` for how it's queried).
 *
 * This is `FileTreeProvider`'s non-`vscode.TreeDataProvider` logic, lifted
 * out behavior-preserving: lazy per-directory reads (cached, invalidated
 * per-directory by the file watcher), the background search index (with an
 * on-disk-walk fallback until the first build finishes), multi-root
 * workspace path prefixing, and file/directory selection semantics.
 *
 * What's deliberately NOT ported from `FileTreeProvider`:
 *   - Anything that only existed to satisfy `vscode.TreeDataProvider`/
 *     `TreeItem`/`TreeView.reveal()` — there's no native tree widget here
 *     to drive.
 *   - `handleCheckboxChange`'s ancestor-batch-filtering. That existed
 *     solely to work around VS Code's native TreeView auto-including every
 *     ancestor directory in the same checkbox-change event. The webview
 *     calls `toggleFile`/`toggleDirectory` directly, one call per actual
 *     click — there's no synthetic batch to filter anymore.
 *   - `previewFilter`/`setPreviewFilter`/`getPreviewFilter` — verified
 *     (grep) to have zero callers anywhere in the codebase; dead code, not
 *     carried forward.
 *
 * What's new here (VS Code's tree widget used to track this implicitly):
 *   - `expandedPaths` — which directories are open.
 *   - `getVisibleRows()` — flattens `expandedPaths` + lazy children + the
 *     active search filter into the ordered row list a virtualized
 *     renderer windows over. Stays host-side and lazy — bounded by what's
 *     actually expanded, never a full-workspace walk — or the "million
 *     files" perf fix regresses.
 */

import ignore, { Ignore } from 'ignore';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEFAULT_SMART_FILTER_PATTERNS } from '../core/filter';
import { matchesSearchQuery, ParsedSearchQuery } from '../core/search-filter';
import type { TreeNodeInfo } from '../core/types';

/** A single file entry in the background search index. */
interface SearchIndexEntry {
  relativePath: string;
  name: string;
}

/**
 * A raw directory entry, before checkbox/search state is computed. Carries
 * `folderRoot`/`folderName` directly (mirroring `FileTreeProvider`'s old
 * `NodeData`) so a recursive walk (e.g. `directoryHasMatchByWalking`) can
 * keep threading them down without re-resolving which workspace folder owns
 * a path on every recursive step.
 */
interface RawEntry {
  absolutePath: string;
  relativePath: string;
  name: string;
  isDirectory: boolean;
  folderRoot: string;
  folderName: string | undefined;
}

/** Where a relative path resolves to on disk, and which workspace folder owns it. */
interface PathContext {
  absolutePath: string;
  folderRoot: string;
  folderName: string | undefined;
}

export class FileTreeModel implements vscode.Disposable {
  private readonly _onDidChangeTree = new vscode.EventEmitter<void>();
  /** Fires whenever something that affects rendering changed (selection, search, structural). */
  readonly onDidChangeTree = this._onDidChangeTree.event;

  private readonly _onDidChangeSelection = new vscode.EventEmitter<string[]>();
  readonly onDidChangeSelection = this._onDidChangeSelection.event;

  private readonly _onDidToggleIndividualFile = new vscode.EventEmitter<{
    relativePath: string;
    checked: boolean;
  }>();
  /**
   * Fires only for a single file's own checkbox being ticked/unticked
   * directly (e.g. after finding it via search) — NOT when it becomes
   * selected as part of a directory bulk-toggle. Ticking one specific file
   * is a deliberate "I want this exact file" action, so the host uses this
   * to auto-register it as a filter override; a directory tick stays
   * subject to the smart filter/gitignore so it's still safe to bulk-select
   * a folder without accidentally dragging in its node_modules.
   */
  readonly onDidToggleIndividualFile = this._onDidToggleIndividualFile.event;

  /** The user's selection: POSIX-style relative paths. */
  private selected = new Set<string>();

  /**
   * Directories the user has explicitly checked. Used only for display
   * (`directoryCheckState`) — does NOT appear in `getSelection()`. Separate
   * from `selected` so that checking a subfolder never makes its parent
   * appear fully-selected.
   */
  private checkedDirs = new Set<string>();

  /** Which directories are currently expanded — the model owns this explicitly now. */
  private expandedPaths = new Set<string>();

  private watchers: vscode.FileSystemWatcher[] = [];

  /**
   * Lazy, per-directory cache of `vscode.workspace.fs.readDirectory()`
   * results — shared by child listing, the search fallback walk, and
   * directory bulk-select, all three of which would otherwise hit disk
   * fresh on every call. Stays fully lazy (only ever holds directories
   * actually visited). Invalidated per-directory by the file watcher.
   */
  private dirListingCache = new Map<string, [string, vscode.FileType][]>();

  private refreshDebounceHandle: ReturnType<typeof setTimeout> | undefined;

  /**
   * Optional search query — a *display* filter. Does not affect selection:
   * hidden files stay selected if they already were.
   */
  private searchQuery: ParsedSearchQuery | undefined;

  /**
   * "Show selected files only" — another *display* filter, same
   * non-destructive contract as `searchQuery`: toggling it never changes
   * `selected`, just what's rendered. Unlike the search index, no disk walk
   * is ever needed to know which directories to keep — `selected` already
   * holds every selected path in memory, so ancestor directories are
   * derived directly from it (see `recomputeSelectedAncestors`).
   */
  private showSelectedOnly = false;
  private selectedAncestorDirs: Set<string> | undefined;

  // -- Background search index --------------------------------------------
  private searchIndex: SearchIndexEntry[] | undefined;
  private indexMatchedFiles: Set<string> | undefined;
  private indexMatchedAncestorDirs: Set<string> | undefined;
  private indexBuildGeneration = 0;
  private skipJunkInIndex = true;
  private rebuildDebounceHandle: ReturnType<typeof setTimeout> | undefined;

  private readonly workspaceFolders: readonly vscode.WorkspaceFolder[];

  constructor(
    workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined,
    initialSelection: string[] = [],
    skipJunkInIndex = true,
  ) {
    this.workspaceFolders = workspaceFolders ?? [];
    this.skipJunkInIndex = skipJunkInIndex;
    for (const p of initialSelection) {
      this.selected.add(p);
    }
    for (const folder of this.workspaceFolders) {
      this.setupWatcher(folder.uri.fsPath);
    }
  }

  // -- Tree reads ----------------------------------------------------------

  /**
   * List one directory's children (or the top level, for `undefined`), with
   * checkbox/search state already computed — the webview never needs a
   * second round trip per row.
   */
  async getChildren(relativePath: string | undefined): Promise<TreeNodeInfo[]> {
    if (this.workspaceFolders.length === 0) {
      return [];
    }

    let entries: RawEntry[];
    if (relativePath === undefined) {
      if (this.workspaceFolders.length === 1) {
        const folder = this.workspaceFolders[0];
        entries = await this.readDirEntries(folder.uri.fsPath, folder.uri.fsPath, undefined);
      } else {
        // Multi-root workspace: surface every folder as a top-level node so
        // files under all of them (not just the first) are reachable.
        entries = this.workspaceFolders.map((folder) => ({
          absolutePath: folder.uri.fsPath,
          relativePath: folder.name,
          name: folder.name,
          isDirectory: true,
          folderRoot: folder.uri.fsPath,
          folderName: folder.name,
        }));
      }
    } else {
      const ctx = this.resolveContext(relativePath);
      if (!ctx) {
        return [];
      }
      entries = await this.readDirEntries(ctx.absolutePath, ctx.folderRoot, ctx.folderName);
    }

    const searchFiltered = await this.applySearchFilter(entries);
    const filtered = this.applySelectionFilter(searchFiltered);
    return filtered.map((e) => this.toTreeNodeInfo(e));
  }

  /**
   * Flatten `expandedPaths` + lazy children + the active search filter into
   * the ordered row list a virtualized renderer windows over. Bounded by
   * what's actually expanded — never a full-workspace walk.
   */
  async getVisibleRows(): Promise<TreeNodeInfo[]> {
    const rows: TreeNodeInfo[] = [];
    await this.collectVisibleRows(undefined, rows);
    return rows;
  }

  private async collectVisibleRows(relativePath: string | undefined, out: TreeNodeInfo[]): Promise<void> {
    const children = await this.getChildren(relativePath);
    for (const child of children) {
      out.push(child);
      // While a search or "show selected only" filter is active, every
      // directory getChildren() returns is already guaranteed to be an
      // ancestor of a match/selection (applySearchFilter/
      // applySelectionFilter exclude anything else) — so treat all of them
      // as expanded for rendering, regardless of the user's actual manual
      // expand/collapse state, exactly like the old FileTreeProvider's
      // search-active default did. Deliberately doesn't mutate
      // `expandedPaths` itself: clearing the filter later reverts to
      // whatever the user had actually expanded before, untouched.
      if (
        child.isDirectory &&
        (this.searchQuery || this.showSelectedOnly || this.expandedPaths.has(child.relativePath))
      ) {
        await this.collectVisibleRows(child.relativePath, out);
      }
    }
  }

  /** Expand or collapse one directory. Callers re-fetch `getVisibleRows()` to see the effect. */
  setExpanded(relativePath: string, expanded: boolean): void {
    if (expanded) {
      this.expandedPaths.add(relativePath);
    } else {
      this.expandedPaths.delete(relativePath);
    }
  }

  isExpanded(relativePath: string): boolean {
    return this.expandedPaths.has(relativePath);
  }

  /**
   * Read a directory's entries, via the shared cache. Errors are never
   * cached (returns `[]` but doesn't remember it), so a transient failure
   * gets retried on the next call rather than sticking forever.
   */
  private async readDirCached(absDir: string): Promise<[string, vscode.FileType][]> {
    const cached = this.dirListingCache.get(absDir);
    if (cached) {
      return cached;
    }
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(absDir));
    } catch {
      return [];
    }
    this.dirListingCache.set(absDir, entries);
    return entries;
  }

  private async readDirEntries(
    parentAbs: string,
    folderRoot: string,
    folderName: string | undefined,
  ): Promise<RawEntry[]> {
    const entries = await this.readDirCached(parentAbs);

    const items: RawEntry[] = [];
    for (const [name, type] of entries) {
      if (name === '.' || name === '..') {
        continue;
      }
      const absolutePath = path.join(parentAbs, name);
      const relativePath = this.toRelative(absolutePath, folderRoot, folderName);
      const isDirectory = (type & vscode.FileType.Directory) !== 0;
      items.push({ absolutePath, relativePath, name, isDirectory, folderRoot, folderName });
    }

    // Sort: directories first, then files; both lexicographic.
    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    return items;
  }

  private toTreeNodeInfo(entry: RawEntry): TreeNodeInfo {
    const checkboxState = entry.isDirectory
      ? this.directoryCheckState(entry.relativePath)
      : this.selected.has(entry.relativePath)
        ? 'checked'
        : 'unchecked';
    const matchesSearch = this.searchQuery
      ? matchesSearchQuery(entry.relativePath, entry.name, this.searchQuery)
      : false;
    return {
      relativePath: entry.relativePath,
      name: entry.name,
      isDirectory: entry.isDirectory,
      checkboxState,
      matchesSearch,
    };
  }

  // -- Search filter -------------------------------------------------------

  /** Set the active search query (or `undefined` to clear it). Display-only, does not change the selection. */
  setSearchQuery(query: ParsedSearchQuery | undefined): void {
    this.searchQuery = query;
    this.recomputeIndexMatches();
    this._onDidChangeTree.fire();
  }

  getSearchQuery(): ParsedSearchQuery | undefined {
    return this.searchQuery;
  }

  /**
   * Re-run the active query against `searchIndex` (if it's built) and cache
   * the result. Done once per query change rather than once per row, or the
   * same query would get re-scanned against the whole index once per row.
   */
  private recomputeIndexMatches(): void {
    if (!this.searchIndex || !this.searchQuery) {
      this.indexMatchedFiles = undefined;
      this.indexMatchedAncestorDirs = undefined;
      return;
    }
    const query = this.searchQuery;
    const matchedFiles = new Set<string>();
    const matchedAncestorDirs = new Set<string>();
    for (const entry of this.searchIndex) {
      if (!matchesSearchQuery(entry.relativePath, entry.name, query)) {
        continue;
      }
      matchedFiles.add(entry.relativePath);
      const parts = entry.relativePath.split('/');
      for (let i = 1; i < parts.length; i++) {
        matchedAncestorDirs.add(parts.slice(0, i).join('/'));
      }
    }
    this.indexMatchedFiles = matchedFiles;
    this.indexMatchedAncestorDirs = matchedAncestorDirs;
  }

  /**
   * Filter a level's raw entries against the active search query. Files
   * must match directly; directories are kept if they, or any descendant,
   * match (so you can still navigate down to a match).
   */
  private async applySearchFilter(entries: RawEntry[]): Promise<RawEntry[]> {
    const query = this.searchQuery;
    if (!query) {
      return entries;
    }
    const kept: RawEntry[] = [];
    for (const entry of entries) {
      if (entry.isDirectory) {
        const hasMatch = this.indexMatchedAncestorDirs
          ? this.indexMatchedAncestorDirs.has(entry.relativePath)
          : await this.directoryHasMatchByWalking(entry, query);
        if (hasMatch) {
          kept.push(entry);
        }
      } else {
        const isMatch = this.indexMatchedFiles
          ? this.indexMatchedFiles.has(entry.relativePath)
          : matchesSearchQuery(entry.relativePath, entry.name, query);
        if (isMatch) {
          kept.push(entry);
        }
      }
    }
    return kept;
  }

  /**
   * Recursively check whether a directory contains at least one file
   * matching the query, by walking it from disk. Short-circuits on the
   * first match found. Fallback used only while `searchIndex` isn't ready
   * yet (index still building, or disabled) — see `applySearchFilter`.
   */
  private async directoryHasMatchByWalking(dir: RawEntry, query: ParsedSearchQuery): Promise<boolean> {
    const entries = await this.readDirCached(dir.absolutePath);
    for (const [name, type] of entries) {
      const absolutePath = path.join(dir.absolutePath, name);
      const isDirectory = (type & vscode.FileType.Directory) !== 0;
      const relativePath = this.toRelative(absolutePath, dir.folderRoot, dir.folderName);
      if (isDirectory) {
        if (
          await this.directoryHasMatchByWalking(
            {
              absolutePath,
              relativePath,
              name,
              isDirectory: true,
              folderRoot: dir.folderRoot,
              folderName: dir.folderName,
            },
            query,
          )
        ) {
          return true;
        }
      } else if (matchesSearchQuery(relativePath, name, query)) {
        return true;
      }
    }
    return false;
  }

  // -- Show-selected-only filter -------------------------------------------

  /** Toggle the "show selected files only" display filter. Never changes `selected` itself. */
  setShowSelectedOnly(value: boolean): void {
    this.showSelectedOnly = value;
    this.recomputeSelectedAncestors();
    this._onDidChangeTree.fire();
  }

  getShowSelectedOnly(): boolean {
    return this.showSelectedOnly;
  }

  /**
   * Derive every ancestor directory of every selected path, straight from
   * `selected` — no disk walk needed (unlike the search index's
   * `matchedAncestorDirs`), since the full set of selected paths is already
   * known in memory. Recomputed whenever the filter is active and the
   * selection changes, mirroring `recomputeIndexMatches`'s "only pay for
   * this once per change, not once per row" shape.
   */
  private recomputeSelectedAncestors(): void {
    if (!this.showSelectedOnly) {
      this.selectedAncestorDirs = undefined;
      return;
    }
    const dirs = new Set<string>();
    for (const p of this.selected) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    }
    this.selectedAncestorDirs = dirs;
  }

  /**
   * Filter a level's raw entries down to just what's selected (or an
   * ancestor of something selected), when the filter is active. Files must
   * be selected directly; directories are kept if they're an ancestor of a
   * selected file, or (rare — e.g. added via Explorer right-click on a
   * folder) selected themselves.
   */
  private applySelectionFilter(entries: RawEntry[]): RawEntry[] {
    if (!this.showSelectedOnly) {
      return entries;
    }
    const ancestorDirs = this.selectedAncestorDirs ?? new Set<string>();
    return entries.filter((entry) =>
      entry.isDirectory
        ? ancestorDirs.has(entry.relativePath) || this.selected.has(entry.relativePath)
        : this.selected.has(entry.relativePath),
    );
  }

  // -- Selection ---------------------------------------------------------

  getSelection(): string[] {
    return Array.from(this.selected).sort();
  }

  /**
   * Replace the current selection. Paths may be file or directory relative
   * paths (the generator expands dirs).
   */
  async setSelection(paths: string[]): Promise<void> {
    this.selected = new Set(paths);
    this.checkedDirs = new Set();
    this.recomputeSelectedAncestors();
    this._onDidChangeTree.fire();
    this._onDidChangeSelection.fire(this.getSelection());
  }

  async clearSelection(): Promise<void> {
    if (this.selected.size === 0 && this.checkedDirs.size === 0) {
      return;
    }
    this.selected.clear();
    this.checkedDirs.clear();
    this.recomputeSelectedAncestors();
    this._onDidChangeTree.fire();
    this._onDidChangeSelection.fire([]);
  }

  /**
   * Toggle a single file's checkbox. When unchecking, also clears any
   * ancestor directories from `checkedDirs` — a parent can no longer be
   * considered "fully selected" after one of its descendants is removed.
   */
  async toggleFile(relativePath: string, checked: boolean): Promise<void> {
    if (checked) {
      this.selected.add(relativePath);
    } else {
      this.selected.delete(relativePath);
      this.removeAncestorDirs(relativePath);
    }
    this.recomputeSelectedAncestors();
    this._onDidToggleIndividualFile.fire({ relativePath, checked });
    this._onDidChangeTree.fire();
    this._onDidChangeSelection.fire(this.getSelection());
  }

  /**
   * Toggle a directory — adds or removes all descendant files. Also
   * maintains `checkedDirs` so that only explicitly-ticked directories
   * count as "fully checked" (not their parents).
   */
  async toggleDirectory(relativePath: string, checked: boolean): Promise<void> {
    const ctx = this.resolveContext(relativePath);
    if (!ctx) {
      return;
    }
    const files = await this.listDescendantFiles(ctx.absolutePath);
    if (checked) {
      this.checkedDirs.add(relativePath);
      for (const f of files) {
        this.selected.add(this.toRelative(f, ctx.folderRoot, ctx.folderName));
      }
    } else {
      this.checkedDirs.delete(relativePath);
      this.removeAncestorDirs(relativePath);
      for (const f of files) {
        this.selected.delete(this.toRelative(f, ctx.folderRoot, ctx.folderName));
      }
    }
    this.recomputeSelectedAncestors();
    this._onDidChangeTree.fire();
    this._onDidChangeSelection.fire(this.getSelection());
  }

  // -- Refresh + watcher -------------------------------------------------

  /** Manually refresh (e.g., from a refresh command). */
  refresh(): void {
    this._onDidChangeTree.fire();
  }

  /**
   * Enable/disable skipping smart-filter junk paths (node_modules, .git,
   * dist, build, lock files, etc.) when building the search index —
   * `aiHandoff.searchSkipJunkDirs`. Triggers a rebuild if the value
   * actually changed. Returns the rebuild's promise so callers that care
   * (e.g. tests) can await it; fire-and-forget callers are free to ignore it.
   */
  async setSkipJunkInIndex(value: boolean): Promise<void> {
    if (this.skipJunkInIndex === value) {
      return;
    }
    this.skipJunkInIndex = value;
    await this.buildSearchIndex();
  }

  /**
   * Walk every workspace folder once, building a flat list of every file's
   * relative path for instant in-memory search matching. Safe to call
   * repeatedly — `indexBuildGeneration` ensures only the most recently
   * *started* call ever commits its result, so overlapping walks can't race
   * and leave a stale, partially-rebuilt index in place.
   */
  async buildSearchIndex(): Promise<void> {
    const generation = ++this.indexBuildGeneration;
    const junkIgnore: Ignore | null = this.skipJunkInIndex
      ? ignore().add([...DEFAULT_SMART_FILTER_PATTERNS])
      : null;

    const multiRoot = this.workspaceFolders.length > 1;
    const out: SearchIndexEntry[] = [];
    for (const folder of this.workspaceFolders) {
      await this.walkForIndex(folder.uri.fsPath, multiRoot ? folder.name : undefined, '', junkIgnore, out);
    }

    if (generation !== this.indexBuildGeneration) {
      return;
    }
    this.searchIndex = out;
    this.recomputeIndexMatches();
    if (this.searchQuery) {
      this._onDidChangeTree.fire();
    }
  }

  private async walkForIndex(
    absDir: string,
    folderName: string | undefined,
    folderRelDir: string,
    junkIgnore: Ignore | null,
    out: SearchIndexEntry[],
  ): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(absDir));
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      if (name === '.' || name === '..') {
        continue;
      }
      const isDirectory = (type & vscode.FileType.Directory) !== 0;
      const folderRelPath = folderRelDir ? `${folderRelDir}/${name}` : name;
      if (junkIgnore?.ignores(isDirectory ? `${folderRelPath}/` : folderRelPath)) {
        continue;
      }
      const absPath = path.join(absDir, name);
      if (isDirectory) {
        await this.walkForIndex(absPath, folderName, folderRelPath, junkIgnore, out);
      } else if ((type & vscode.FileType.File) !== 0) {
        const relativePath = folderName ? `${folderName}/${folderRelPath}` : folderRelPath;
        out.push({ relativePath, name });
      }
    }
  }

  /** Coalesces file-watcher-triggered index rebuilds — a burst of fs events triggers one rebuild, not one per event. */
  private scheduleIndexRebuild(): void {
    clearTimeout(this.rebuildDebounceHandle);
    this.rebuildDebounceHandle = setTimeout(() => {
      void this.buildSearchIndex();
    }, 2000);
  }

  // -- Helpers -----------------------------------------------------------

  private toRelative(absolutePath: string, folderRoot: string, folderName: string | undefined): string {
    const rel = path.relative(folderRoot, absolutePath).split(path.sep).join('/');
    return folderName ? `${folderName}/${rel}` : rel;
  }

  /**
   * Resolve a relativePath back to its absolute path, folder root, and
   * (multi-root only) owning folder name.
   */
  private resolveContext(relativePath: string): PathContext | undefined {
    if (this.workspaceFolders.length === 0) {
      return undefined;
    }
    if (this.workspaceFolders.length === 1) {
      const folder = this.workspaceFolders[0];
      return {
        absolutePath: path.join(folder.uri.fsPath, relativePath),
        folderRoot: folder.uri.fsPath,
        folderName: undefined,
      };
    }
    const slash = relativePath.indexOf('/');
    const folderName = slash === -1 ? relativePath : relativePath.slice(0, slash);
    const rest = slash === -1 ? '' : relativePath.slice(slash + 1);
    const folder = this.workspaceFolders.find((f) => f.name === folderName);
    if (!folder) {
      return undefined;
    }
    return {
      absolutePath: rest ? path.join(folder.uri.fsPath, rest) : folder.uri.fsPath,
      folderRoot: folder.uri.fsPath,
      folderName,
    };
  }

  /**
   * Resolve a relativePath produced by this model back to an absolute
   * filesystem path. Single-root workspaces resolve directly against that
   * folder; multi-root workspaces read the folder name from the first path
   * segment (see `toRelative`).
   */
  resolveAbsolutePath(relativePath: string): string | undefined {
    return this.resolveContext(relativePath)?.absolutePath;
  }

  /**
   * Compute the checkbox state for a directory. Returns 'checked' when the
   * user has explicitly ticked this directory OR an ancestor directory, OR
   * when the directory path itself is in `selected` (e.g. added via
   * Explorer right-click). Deliberately does NOT return 'checked' just
   * because some descendant files are in `selected` — checking a subfolder
   * must never make its parent appear fully selected.
   */
  private directoryCheckState(relativeDirPath: string): 'checked' | 'unchecked' {
    if (this.checkedDirs.has(relativeDirPath)) {
      return 'checked';
    }
    const parts = relativeDirPath.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (this.checkedDirs.has(parts.slice(0, i).join('/'))) {
        return 'checked';
      }
    }
    if (this.selected.has(relativeDirPath)) {
      return 'checked';
    }
    return 'unchecked';
  }

  /**
   * Remove all ancestor directory paths from `checkedDirs` for the given
   * path. Called when a file or directory is unchecked — a parent can no
   * longer be considered "fully selected" after one of its descendants is
   * removed.
   */
  private removeAncestorDirs(relativePath: string): void {
    const parts = relativePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      this.checkedDirs.delete(parts.slice(0, i).join('/'));
    }
  }

  /** Recursively list all file absolute paths under a directory. Used when the user ticks a directory checkbox. */
  private async listDescendantFiles(absoluteDirPath: string): Promise<string[]> {
    const out: string[] = [];
    await this.walk(absoluteDirPath, out);
    return out;
  }

  private async walk(dir: string, accumulator: string[]): Promise<void> {
    const entries = await this.readDirCached(dir);
    for (const [name, type] of entries) {
      const child = path.join(dir, name);
      if ((type & vscode.FileType.Directory) !== 0) {
        await this.walk(child, accumulator);
      } else if ((type & vscode.FileType.File) !== 0) {
        accumulator.push(child);
      }
    }
  }

  /**
   * Debounces the tree-change notification fired on file-watcher events. A
   * burst (autosave, a linter writing cache files, git operations, an
   * incremental build) would otherwise fire one notification per event.
   * Much shorter than the index rebuild's own debounce (`scheduleIndexRebuild`)
   * since this only reflects already-cached/cheap data, not a full disk
   * walk — it just needs to coalesce a burst, not protect against expensive work.
   */
  private scheduleRefresh(): void {
    clearTimeout(this.refreshDebounceHandle);
    this.refreshDebounceHandle = setTimeout(() => {
      this._onDidChangeTree.fire();
    }, 300);
  }

  private setupWatcher(root: string): void {
    const pattern = new vscode.RelativePattern(root, '**/*');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onFsEvent = (uri: vscode.Uri): void => {
      // A create/delete only changes its immediate parent's listing —
      // invalidate just that entry rather than the whole cache.
      this.dirListingCache.delete(path.dirname(uri.fsPath));
      this.scheduleRefresh();
      this.scheduleIndexRebuild();
    };
    watcher.onDidCreate(onFsEvent);
    watcher.onDidDelete(onFsEvent);
    this.watchers.push(watcher);
  }

  dispose(): void {
    clearTimeout(this.rebuildDebounceHandle);
    clearTimeout(this.refreshDebounceHandle);
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this._onDidChangeTree.dispose();
    this._onDidChangeSelection.dispose();
    this._onDidToggleIndividualFile.dispose();
  }
}
