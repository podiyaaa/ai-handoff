/**
 * File tree provider — the sidebar TreeView with checkboxes.
 *
 * Walks the workspace lazily (children-on-demand) so large projects don't
 * pay the cost up front. Every directory read is cached (`dirListingCache`,
 * invalidated per-directory by the file watcher) so repeated renders,
 * refreshes, and directory-checkbox toggles don't keep re-reading the same
 * directories from disk. Tracks a Set of selected relative paths and exposes
 * change events for the action panel to subscribe to.
 *
 * Search is the one deliberate exception to "lazy, no cost up front": a
 * background index (`buildSearchIndex`) walks the whole workspace once so
 * search matching is an in-memory scan instead of a live filesystem walk on
 * every keystroke. Until that first walk finishes, search falls back to the
 * (slower) on-disk walk, so search still works immediately — it's just not
 * yet fast.
 *
 * Selection semantics:
 *   - Ticking a file selects just that file
 *   - Ticking a directory selects all its descendant files (recursively)
 *   - Unticking a directory unselects all descendants
 *   - A directory's checkbox shows as partial when some children are selected
 *
 * The provider is intentionally unaware of filtering — it shows everything
 * by default, with a "smart filter" preview so users can see what would
 * be skipped without losing visibility.
 */

import ignore, { Ignore } from 'ignore';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEFAULT_SMART_FILTER_PATTERNS, FilterChain } from '../core/filter';
import { matchesSearchQuery, ParsedSearchQuery } from '../core/search-filter';

/** A single file entry in the background search index. */
interface SearchIndexEntry {
  relativePath: string;
  name: string;
}

/**
 * Internal cache entry. Built lazily as the user expands directories.
 */
interface NodeData {
  /** Absolute path on disk. */
  absolutePath: string;
  /**
   * POSIX-style path relative to the owning workspace folder. In multi-root
   * workspaces this is prefixed with the folder name (e.g. "buzzer/src/x.ts")
   * so paths stay unique across folders; single-root workspaces keep the
   * unprefixed form for backwards compatibility with saved selections.
   */
  relativePath: string;
  /** Display name (last path segment). */
  name: string;
  /** True for directories. */
  isDirectory: boolean;
  /** Absolute path of the workspace folder this node belongs to. */
  folderRoot: string;
  /** Workspace folder name — set only when multiple folders are open. */
  folderName: string | undefined;
}

/**
 * The TreeItem class — extends VS Code's so we can attach our path data.
 */
export class FileTreeItem extends vscode.TreeItem {
  constructor(public readonly data: NodeData, collapsibleState: vscode.TreeItemCollapsibleState) {
    super(data.name, collapsibleState);

    // A STABLE id (never changes for the same logical file/folder — not to
    // be confused with the churning generation-counter id from an earlier,
    // reverted attempt, which caused a real bug by making VS Code treat
    // every node as "new" on every search keystroke). relativePath is
    // already unique across the whole tree, so this is a safe, permanent
    // identity VS Code can use to track expand/collapse and selection state
    // — the documented, recommended way to do this per TreeItem.id's own
    // docs, and needed for "Collapse All" and reveal() to reliably track
    // every node instead of falling back to a fragile position-based guess.
    this.id = data.relativePath || data.name;
    this.resourceUri = vscode.Uri.file(data.absolutePath);
    this.tooltip = data.relativePath || data.name;

    if (data.isDirectory) {
      this.contextValue = 'aiHandoff.directory';
      this.iconPath = new vscode.ThemeIcon('folder');
    } else {
      this.contextValue = 'aiHandoff.file';
      // Use the file icon theme for natural look
      this.iconPath = vscode.ThemeIcon.File;
      // Clicking a file should open it in the editor
      this.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [this.resourceUri],
      };
    }
  }
}

/**
 * The provider itself.
 */
export class FileTreeProvider
  implements vscode.TreeDataProvider<FileTreeItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    FileTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _onDidChangeSelection = new vscode.EventEmitter<string[]>();
  /** Fires whenever the selection set changes. Emits the new list of paths. */
  readonly onDidChangeSelection = this._onDidChangeSelection.event;

  private readonly _onDidToggleIndividualFile = new vscode.EventEmitter<{
    relativePath: string;
    checked: boolean;
  }>();
  /**
   * Fires only for a single file's own checkbox being ticked/unticked directly
   * (e.g. after finding it via search) — NOT when it becomes selected as part
   * of a directory bulk-toggle. Ticking one specific file is a deliberate "I
   * want this exact file" action, so extension.ts uses this to auto-register
   * it as a filter override; a directory tick stays subject to the smart
   * filter/gitignore so it's still safe to bulk-select a folder without
   * accidentally dragging in its node_modules.
   */
  readonly onDidToggleIndividualFile = this._onDidToggleIndividualFile.event;

  /** The user's selection: POSIX-style relative paths (files, or raw dir paths from right-click). */
  private selected = new Set<string>();

  /**
   * Directories the user has explicitly checked via the sidebar checkbox.
   * Used only for display (directoryCheckState) — does NOT appear in getSelection().
   * Separate from `selected` so that checking a subfolder never makes its parent
   * appear fully-selected.
   */
  private checkedDirs = new Set<string>();

  /** One file watcher per workspace folder, so we refresh on file changes. */
  private watchers: vscode.FileSystemWatcher[] = [];

  /**
   * Lazy, per-directory cache of `vscode.workspace.fs.readDirectory()`
   * results — shared by tree rendering (`readDirectory`), the search
   * fallback walk, and directory bulk-select (`walk`), all three of which
   * used to hit disk fresh on every single call. Unlike `searchIndex` below,
   * this stays fully lazy (only ever holds directories actually visited) —
   * it doesn't compromise "no cost up front" for the plain tree. Invalidated
   * per-directory by the file watcher, not wholesale, since a create/delete
   * only changes its immediate parent's listing.
   */
  private dirListingCache = new Map<string, [string, vscode.FileType][]>();

  /** Debounces the tree refresh fired on file-watcher events — see `scheduleRefresh`. */
  private refreshDebounceHandle: ReturnType<typeof setTimeout> | undefined;

  /** Optional filter — used to grey out items that would be skipped. */
  private previewFilter: FilterChain | undefined;

  /**
   * Optional search query — a *display* filter (unlike previewFilter, it
   * hides non-matching items entirely rather than greying them out). Does
   * not affect selection: hidden files stay selected if they already were.
   */
  private searchQuery: ParsedSearchQuery | undefined;

  // -- Background search index --------------------------------------------
  //
  // Search matching (`directoryHasMatchByWalking`) re-reads a directory's
  // entire subtree from disk on every keystroke, with no caching anywhere —
  // fine for a small project, a real hang on a huge one (every character
  // typed re-walks large parts of the tree from disk). `searchIndex` is a
  // flat, in-memory list of every file's relative path, built once by a
  // background walk and kept in sync via the file watcher below, so search
  // becomes an in-memory scan instead of a filesystem walk. Until the first
  // build finishes (or if it's disabled), `searchIndex` stays undefined and
  // callers fall back to the on-disk walk.
  private searchIndex: SearchIndexEntry[] | undefined;
  /** Files matching the active query, once `searchIndex` is ready. */
  private indexMatchedFiles: Set<string> | undefined;
  /** Every ancestor directory of a matched file, once `searchIndex` is ready. */
  private indexMatchedAncestorDirs: Set<string> | undefined;
  /** Bumped on every rebuild so a stale in-flight walk can detect it's been superseded and discard its result instead of clobbering a newer one. */
  private indexBuildGeneration = 0;
  /** Whether the index build should skip smart-filter junk paths (`aiHandoff.searchSkipJunkDirs`). */
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

  // -- TreeDataProvider --------------------------------------------------

  getTreeItem(element: FileTreeItem): vscode.TreeItem {
    const item = element;
    // Apply checkbox state based on current selection.
    if (item.data.isDirectory) {
      const state = this.directoryCheckState(item.data.relativePath);
      item.checkboxState = state;
    } else {
      item.checkboxState = this.selected.has(item.data.relativePath)
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
    }
    return item;
  }

  async getChildren(element?: FileTreeItem): Promise<FileTreeItem[]> {
    if (this.workspaceFolders.length === 0) {
      return [];
    }

    let items: FileTreeItem[];
    if (!element) {
      if (this.workspaceFolders.length === 1) {
        const folder = this.workspaceFolders[0];
        items = await this.readDirectory(folder.uri.fsPath, folder.uri.fsPath, undefined);
      } else {
        // Multi-root workspace: surface every folder as a top-level node so
        // files under all of them (not just the first) are reachable.
        items = this.workspaceFolders.map((folder) => {
          const data: NodeData = {
            absolutePath: folder.uri.fsPath,
            relativePath: folder.name,
            name: folder.name,
            isDirectory: true,
            folderRoot: folder.uri.fsPath,
            folderName: folder.name,
          };
          return new FileTreeItem(data, this.directoryCollapsibleState(/* topLevel */ true));
        });
      }
    } else {
      items = await this.readDirectory(element.data.absolutePath, element.data.folderRoot, element.data.folderName);
    }

    return this.applySearchFilter(items);
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

  private async readDirectory(
    parentAbs: string,
    folderRoot: string,
    folderName: string | undefined,
  ): Promise<FileTreeItem[]> {
    const entries = await this.readDirCached(parentAbs);

    const items: FileTreeItem[] = [];
    for (const [name, type] of entries) {
      if (name === '.' || name === '..') {
        continue;
      }
      const absolutePath = path.join(parentAbs, name);
      const relativePath = this.toRelative(absolutePath, folderRoot, folderName);
      const isDirectory = (type & vscode.FileType.Directory) !== 0;

      // Skip symlinks pointing to themselves / outside the workspace for safety.
      if ((type & vscode.FileType.SymbolicLink) !== 0 && !isDirectory) {
        // Still allow symlinked files
      }

      const data: NodeData = { absolutePath, relativePath, name, isDirectory, folderRoot, folderName };
      const collapsibleState = isDirectory
        ? this.directoryCollapsibleState(/* topLevel */ false)
        : vscode.TreeItemCollapsibleState.None;
      items.push(new FileTreeItem(data, collapsibleState));
    }

    // Sort: directories first, then files; both lexicographic.
    items.sort((a, b) => {
      if (a.data.isDirectory !== b.data.isDirectory) {
        return a.data.isDirectory ? -1 : 1;
      }
      return a.data.name < b.data.name ? -1 : a.data.name > b.data.name ? 1 : 0;
    });

    return items;
  }

  // -- Expand/collapse state -----------------------------------------------

  /**
   * Decide a directory's *default* collapsible state for a freshly-rendered
   * node: expanded while a search is active (so matches are visible without
   * manual clicks) or for a top-level multi-root folder, collapsed otherwise.
   *
   * This is only a default — it doesn't retroactively change a node VS Code
   * has already rendered (VS Code remembers a node's current expand/collapse
   * UI state across a plain refresh regardless of what we return here). To
   * actually force an already-rendered node open, use `TreeView.reveal(item,
   * { expand: true })` — see `revealAllDirectories` in extension.ts — which
   * is the documented, safe way to do this. An earlier attempt forced it by
   * tagging every item's `id` with a bumped counter so VS Code would treat
   * the whole tree as new; that identity churn, happening automatically and
   * repeatedly while the user might be mid-click on a tree checkbox, could
   * get a click misattributed to the wrong (ancestor) node — e.g. ticking
   * one file right before clearing the search box ended up toggling its
   * whole parent folder instead, silently selecting many unintended files.
   * `reveal()` doesn't touch item identity, so it can't cause that.
   */
  private directoryCollapsibleState(topLevel: boolean): vscode.TreeItemCollapsibleState {
    if (this.searchQuery || topLevel) {
      return vscode.TreeItemCollapsibleState.Expanded;
    }
    return vscode.TreeItemCollapsibleState.Collapsed;
  }

  /**
   * Resolve the parent of a tree element, purely from its already-known path
   * data (no filesystem access) — required by `TreeView.reveal()` to build
   * the ancestor chain down to an element that isn't currently rendered.
   */
  getParent(element: FileTreeItem): FileTreeItem | undefined {
    const { folderRoot, folderName, absolutePath } = element.data;
    if (absolutePath === folderRoot) {
      // Element is itself a top-level node (a multi-root folder-root pseudo
      // node, or — in single-root mode — the workspace root, which has no
      // node of its own since getChildren(undefined) returns its contents
      // directly) — either way, there's no parent to reveal through.
      return undefined;
    }

    const parentAbsolutePath = path.dirname(absolutePath);
    if (parentAbsolutePath === folderRoot) {
      if (!folderName) {
        return undefined; // single-root: the root has no node of its own
      }
      const data: NodeData = {
        absolutePath: folderRoot,
        relativePath: folderName,
        name: folderName,
        isDirectory: true,
        folderRoot,
        folderName,
      };
      return new FileTreeItem(data, this.directoryCollapsibleState(/* topLevel */ true));
    }

    const data: NodeData = {
      absolutePath: parentAbsolutePath,
      relativePath: this.toRelative(parentAbsolutePath, folderRoot, folderName),
      name: path.basename(parentAbsolutePath),
      isDirectory: true,
      folderRoot,
      folderName,
    };
    return new FileTreeItem(data, this.directoryCollapsibleState(/* topLevel */ false));
  }

  // -- Search filter -------------------------------------------------------

  /**
   * Set the active search query (or `undefined` to clear it). Triggers a
   * tree refresh — display-only, does not change the selection.
   */
  setSearchQuery(query: ParsedSearchQuery | undefined): void {
    this.searchQuery = query;
    this.recomputeIndexMatches();
    this._onDidChangeTreeData.fire();
  }

  /** The active search query, if any. */
  getSearchQuery(): ParsedSearchQuery | undefined {
    return this.searchQuery;
  }

  /**
   * Re-run the active query against `searchIndex` (if it's built) and cache
   * the result. Done once per query change rather than per getChildren()
   * call — getChildren() runs once per currently-rendered node, so without
   * this cache the same query would get re-scanned against the whole index
   * once per visible node.
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
   * Filter a level's items against the active search query. Files must
   * match directly; directories are kept if they, or any descendant, match
   * (so you can still navigate down to a match).
   */
  private async applySearchFilter(items: FileTreeItem[]): Promise<FileTreeItem[]> {
    const query = this.searchQuery;
    if (!query) {
      return items;
    }
    const kept: FileTreeItem[] = [];
    for (const item of items) {
      if (item.data.isDirectory) {
        const hasMatch = this.indexMatchedAncestorDirs
          ? this.indexMatchedAncestorDirs.has(item.data.relativePath)
          : await this.directoryHasMatchByWalking(item.data, query);
        if (hasMatch) {
          kept.push(item);
        }
      } else {
        const isMatch = this.indexMatchedFiles
          ? this.indexMatchedFiles.has(item.data.relativePath)
          : matchesSearchQuery(item.data.relativePath, item.data.name, query);
        if (isMatch) {
          kept.push(item);
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
  private async directoryHasMatchByWalking(dirData: NodeData, query: ParsedSearchQuery): Promise<boolean> {
    const entries = await this.readDirCached(dirData.absolutePath);
    for (const [name, type] of entries) {
      const absolutePath = path.join(dirData.absolutePath, name);
      const isDirectory = (type & vscode.FileType.Directory) !== 0;
      const relativePath = this.toRelative(absolutePath, dirData.folderRoot, dirData.folderName);
      if (isDirectory) {
        const childData: NodeData = {
          absolutePath,
          relativePath,
          name,
          isDirectory: true,
          folderRoot: dirData.folderRoot,
          folderName: dirData.folderName,
        };
        if (await this.directoryHasMatchByWalking(childData, query)) {
          return true;
        }
      } else if (matchesSearchQuery(relativePath, name, query)) {
        return true;
      }
    }
    return false;
  }

  // -- Selection ---------------------------------------------------------

  /**
   * Get the current selection as a sorted array of relative paths.
   */
  getSelection(): string[] {
    return Array.from(this.selected).sort();
  }

  /**
   * Replace the current selection. Triggers tree refresh + change event.
   * Paths may be file or directory relative paths (the generator expands dirs).
   */
  async setSelection(paths: string[]): Promise<void> {
    this.selected = new Set(paths);
    // checkedDirs is purely a sidebar-display concern. When selection is
    // overwritten programmatically (e.g. right-click or load saved set) we
    // reset it — the user hasn't clicked checkboxes, so no dir is "fully
    // checked" from the sidebar's point of view.
    this.checkedDirs = new Set();
    this._onDidChangeTreeData.fire();
    this._onDidChangeSelection.fire(this.getSelection());
  }

  /**
   * Clear all selected items.
   */
  async clearSelection(): Promise<void> {
    if (this.selected.size === 0 && this.checkedDirs.size === 0) {
      return;
    }
    this.selected.clear();
    this.checkedDirs.clear();
    this._onDidChangeTreeData.fire();
    this._onDidChangeSelection.fire([]);
  }

  /**
   * Toggle a single file's checkbox.
   * When unchecking, also clears any ancestor directories from checkedDirs
   * because the directory is no longer fully selected as a unit.
   */
  async toggleFile(relativePath: string, checked: boolean): Promise<void> {
    if (checked) {
      this.selected.add(relativePath);
    } else {
      this.selected.delete(relativePath);
      this.removeAncestorDirs(relativePath);
    }
    this._onDidToggleIndividualFile.fire({ relativePath, checked });
    this._onDidChangeSelection.fire(this.getSelection());
  }

  /**
   * Toggle a directory — adds or removes all descendant files.
   *
   * Also maintains `checkedDirs` so that only explicitly-ticked directories
   * show a checked checkbox in the sidebar (not their parents).
   */
  async toggleDirectory(dirData: NodeData, checked: boolean): Promise<void> {
    const dirRelPath = dirData.relativePath;
    const files = await this.listDescendantFiles(dirData.absolutePath);
    if (checked) {
      this.checkedDirs.add(dirRelPath);
      for (const f of files) {
        this.selected.add(this.toRelative(f, dirData.folderRoot, dirData.folderName));
      }
    } else {
      this.checkedDirs.delete(dirRelPath);
      // Also uncheck any ancestor directories — they are no longer fully selected.
      this.removeAncestorDirs(dirRelPath);
      for (const f of files) {
        this.selected.delete(this.toRelative(f, dirData.folderRoot, dirData.folderName));
      }
    }
    // Refresh the whole tree so ancestor/sibling checkbox states update.
    this._onDidChangeTreeData.fire();
    this._onDidChangeSelection.fire(this.getSelection());
  }

  /**
   * Handle the TreeView's onDidChangeCheckboxState event.
   * Called by extension.ts after wiring up the view.
   *
   * VS Code auto-includes every ancestor of the item you actually clicked in
   * the SAME event batch, to keep their checkbox visuals in sync (e.g.
   * ticking a deeply nested file also reports its parent, grandparent, etc.
   * as "checked" in the same call) — this is native VS Code tree behavior,
   * not something we asked for. Treating every entry as an independent user
   * action was the actual cause of "ticking one file selects its whole
   * parent folder": the auto-included ancestor entries were triggering full
   * recursive toggleDirectory calls nobody asked for. Only the *deepest*
   * item in a batch (one that isn't an ancestor of any other item in the
   * same batch) is the real click; everything else is sync noise to ignore.
   */
  async handleCheckboxChange(
    items: ReadonlyArray<[FileTreeItem, vscode.TreeItemCheckboxState]>,
  ): Promise<void> {
    const paths = items.map(([item]) => item.data.relativePath);
    const isAncestorOfAnother = (candidate: string): boolean =>
      paths.some((other) => other !== candidate && other.startsWith(`${candidate}/`));

    for (const [item, state] of items) {
      if (isAncestorOfAnother(item.data.relativePath)) {
        continue;
      }
      const checked = state === vscode.TreeItemCheckboxState.Checked;
      if (item.data.isDirectory) {
        await this.toggleDirectory(item.data, checked);
      } else {
        await this.toggleFile(item.data.relativePath, checked);
      }
    }
  }

  // -- Refresh + watcher -------------------------------------------------

  /** Manually refresh the tree (e.g., from a refresh command). */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Optional: set a filter chain that will be used to grey out items
   * that would be skipped. Pure preview — does not affect selection.
   */
  setPreviewFilter(chain: FilterChain | undefined): void {
    this.previewFilter = chain;
    this._onDidChangeTreeData.fire();
  }

  /** Expose the preview filter for callers that want to display it. */
  getPreviewFilter(): FilterChain | undefined {
    return this.previewFilter;
  }

  /**
   * Enable/disable skipping smart-filter junk paths (node_modules, .git,
   * dist, build, lock files, etc.) when building the search index —
   * `aiHandoff.searchSkipJunkDirs`. Triggers a rebuild if the value actually
   * changed, since it changes what the existing index would contain. Returns
   * the rebuild's promise so callers that care (e.g. tests) can await it;
   * fire-and-forget callers (the config-change listener) are free to ignore it.
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
   * relative path for instant in-memory search matching (see `searchIndex`
   * above). Safe to call repeatedly — e.g. from the file watcher below —
   * `indexBuildGeneration` ensures only the most recently *started* call
   * ever commits its result, so overlapping walks can't race and leave a
   * stale, partially-rebuilt index in place.
   */
  async buildSearchIndex(): Promise<void> {
    const generation = ++this.indexBuildGeneration;
    const junkIgnore: Ignore | null = this.skipJunkInIndex
      ? ignore().add([...DEFAULT_SMART_FILTER_PATTERNS])
      : null;

    // Match toRelative()'s convention: only prefix with the folder name in a
    // multi-root workspace — a single-root workspace's paths must stay
    // unprefixed, or they won't line up with the (unprefixed) relativePath
    // on-disk rendering uses to check `indexMatchedFiles`/`indexMatchedAncestorDirs`.
    const multiRoot = this.workspaceFolders.length > 1;
    const out: SearchIndexEntry[] = [];
    for (const folder of this.workspaceFolders) {
      await this.walkForIndex(folder.uri.fsPath, multiRoot ? folder.name : undefined, '', junkIgnore, out);
    }

    if (generation !== this.indexBuildGeneration) {
      // Superseded by a newer build (workspace changed, setting toggled, or
      // another file-watcher-triggered rebuild started) — discard.
      return;
    }
    this.searchIndex = out;
    this.recomputeIndexMatches();
    // Only a search in progress can actually change what's rendered — with
    // no active query, applySearchFilter() is a no-op regardless of what the
    // index now contains, so firing a full refresh here would just be an
    // expensive no-op UI refresh (VS Code re-fetching every expanded node).
    // Structural changes (a file/folder appearing or disappearing) are
    // already covered by the watcher's own (debounced) refresh below.
    if (this.searchQuery) {
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Recursive walk for one workspace folder. `folderRelDir` is the path
   * relative to *this folder's own root* (no multi-root folder-name prefix)
   * — that's what junk patterns like `node_modules/` need to be tested
   * against, since a workspace folder that happens to be named e.g. `dist`
   * must not itself get excluded.
   */
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

  /**
   * Coalesce file-watcher-triggered rebuilds: a burst of creates/deletes
   * (e.g. `npm install`, a branch checkout) would otherwise trigger a full
   * re-walk per event. Debounced the same way `SearchBarProvider` debounces
   * keystrokes, just longer — these bursts play out over seconds, not
   * milliseconds.
   */
  private scheduleIndexRebuild(): void {
    clearTimeout(this.rebuildDebounceHandle);
    this.rebuildDebounceHandle = setTimeout(() => {
      void this.buildSearchIndex();
    }, 2000);
  }

  // -- Helpers -----------------------------------------------------------

  /**
   * Convert an absolute path to a POSIX-style path relative to its owning
   * workspace folder, prefixed with the folder name when multiple folders
   * are open (so paths stay unique across folders).
   */
  private toRelative(absolutePath: string, folderRoot: string, folderName: string | undefined): string {
    const rel = path.relative(folderRoot, absolutePath).split(path.sep).join('/');
    // Normalize to POSIX separators so it matches what the rest of the
    // pipeline expects (FilterChain, formatHandoff, etc.).
    return folderName ? `${folderName}/${rel}` : rel;
  }

  /**
   * Resolve a relativePath produced by this provider back to an absolute
   * filesystem path. Single-root workspaces resolve directly against that
   * folder; multi-root workspaces read the folder name from the first path
   * segment (see `toRelative`).
   */
  resolveAbsolutePath(relativePath: string): string | undefined {
    if (this.workspaceFolders.length === 0) {
      return undefined;
    }
    if (this.workspaceFolders.length === 1) {
      return path.join(this.workspaceFolders[0].uri.fsPath, relativePath);
    }
    const slash = relativePath.indexOf('/');
    const folderName = slash === -1 ? relativePath : relativePath.slice(0, slash);
    const rest = slash === -1 ? '' : relativePath.slice(slash + 1);
    const folder = this.workspaceFolders.find((f) => f.name === folderName);
    return folder ? path.join(folder.uri.fsPath, rest) : undefined;
  }

  /**
   * Compute the checkbox state for a directory.
   *
   * Returns Checked when the user has explicitly ticked this directory OR
   * an ancestor directory in the sidebar, OR when the directory path itself
   * is in `selected` (e.g. added via Explorer right-click).
   *
   * Deliberately does NOT return Checked just because some descendant files
   * are in `selected` — that was the source of Bug 1, where checking a
   * subfolder made the parent appear fully selected.
   */
  private directoryCheckState(relativeDirPath: string): vscode.TreeItemCheckboxState {
    // Explicitly checked via the sidebar checkbox.
    if (this.checkedDirs.has(relativeDirPath)) {
      return vscode.TreeItemCheckboxState.Checked;
    }
    // An ancestor directory was explicitly checked — this subdir is implicitly
    // fully selected as part of that parent selection.
    const parts = relativeDirPath.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (this.checkedDirs.has(parts.slice(0, i).join('/'))) {
        return vscode.TreeItemCheckboxState.Checked;
      }
    }
    // The directory path itself is in `selected` (e.g. added via right-click
    // without going through the sidebar checkbox path).
    if (this.selected.has(relativeDirPath)) {
      return vscode.TreeItemCheckboxState.Checked;
    }
    return vscode.TreeItemCheckboxState.Unchecked;
  }

  /**
   * Remove all ancestor directory paths from `checkedDirs` for the given path.
   * Called when a file or directory is unchecked — a parent can no longer be
   * considered "fully selected" after one of its descendants is removed.
   */
  private removeAncestorDirs(relativePath: string): void {
    const parts = relativePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      this.checkedDirs.delete(parts.slice(0, i).join('/'));
    }
  }

  /**
   * Recursively list all file absolute paths under a directory.
   * Used when the user ticks a directory checkbox.
   */
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
   * Debounces the tree refresh fired on file-watcher events. A single
   * create/delete used to fire `_onDidChangeTreeData` immediately and
   * unconditionally — fine for one event, but a burst (autosave, a linter
   * writing cache files, git operations, an incremental build) fired one
   * full refresh per event back-to-back, each making VS Code re-fetch every
   * currently-expanded node. Much shorter than the index rebuild's own
   * debounce (`scheduleIndexRebuild`) since this only re-renders already-
   * cached/cheap data, not a full disk walk — it just needs to coalesce a
   * burst, not protect against expensive work.
   */
  private scheduleRefresh(): void {
    clearTimeout(this.refreshDebounceHandle);
    this.refreshDebounceHandle = setTimeout(() => {
      this._onDidChangeTreeData.fire();
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
    // Don't refresh on every keystroke — onDidChange is too noisy.
    this.watchers.push(watcher);
  }

  dispose(): void {
    clearTimeout(this.rebuildDebounceHandle);
    clearTimeout(this.refreshDebounceHandle);
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this._onDidChangeTreeData.dispose();
    this._onDidChangeSelection.dispose();
    this._onDidToggleIndividualFile.dispose();
  }
}
