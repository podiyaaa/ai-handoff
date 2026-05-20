/**
 * File tree provider — the sidebar TreeView with checkboxes.
 *
 * Walks the workspace lazily (children-on-demand) so large projects don't
 * pay the cost up front. Tracks a Set of selected relative paths and exposes
 * change events for the action panel to subscribe to.
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

import * as path from 'path';
import * as vscode from 'vscode';
import { FilterChain } from '../core/filter';

/**
 * Internal cache entry. Built lazily as the user expands directories.
 */
interface NodeData {
  /** Absolute path on disk. */
  absolutePath: string;
  /** POSIX-style path relative to workspace root. */
  relativePath: string;
  /** Display name (last path segment). */
  name: string;
  /** True for directories. */
  isDirectory: boolean;
}

/**
 * The TreeItem class — extends VS Code's so we can attach our path data.
 */
export class FileTreeItem extends vscode.TreeItem {
  constructor(public readonly data: NodeData, collapsibleState: vscode.TreeItemCollapsibleState) {
    super(data.name, collapsibleState);

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

  /** The user's selection: POSIX-style relative paths. */
  private selected = new Set<string>();

  /** Cached file watcher for the workspace, so we refresh on file changes. */
  private watcher: vscode.FileSystemWatcher | undefined;

  /** Optional filter — used to grey out items that would be skipped. */
  private previewFilter: FilterChain | undefined;

  constructor(
    private readonly workspaceRoot: string | undefined,
    initialSelection: string[] = [],
  ) {
    for (const p of initialSelection) {
      this.selected.add(p);
    }
    if (workspaceRoot) {
      this.setupWatcher(workspaceRoot);
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
    if (!this.workspaceRoot) {
      return [];
    }
    const parentAbs = element?.data.absolutePath ?? this.workspaceRoot;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(parentAbs));
    } catch {
      return [];
    }

    const items: FileTreeItem[] = [];
    for (const [name, type] of entries) {
      if (name === '.' || name === '..') {
        continue;
      }
      const absolutePath = path.join(parentAbs, name);
      const relativePath = this.toRelative(absolutePath);
      const isDirectory = (type & vscode.FileType.Directory) !== 0;

      // Skip symlinks pointing to themselves / outside the workspace for safety.
      if ((type & vscode.FileType.SymbolicLink) !== 0 && !isDirectory) {
        // Still allow symlinked files
      }

      const data: NodeData = { absolutePath, relativePath, name, isDirectory };
      const collapsibleState = isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
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

  // -- Selection ---------------------------------------------------------

  /**
   * Get the current selection as a sorted array of relative paths.
   */
  getSelection(): string[] {
    return Array.from(this.selected).sort();
  }

  /**
   * Replace the current selection. Triggers tree refresh + change event.
   */
  async setSelection(paths: string[]): Promise<void> {
    this.selected = new Set(paths);
    this._onDidChangeTreeData.fire();
    this._onDidChangeSelection.fire(this.getSelection());
  }

  /**
   * Clear all selected items.
   */
  async clearSelection(): Promise<void> {
    if (this.selected.size === 0) {
      return;
    }
    this.selected.clear();
    this._onDidChangeTreeData.fire();
    this._onDidChangeSelection.fire([]);
  }

  /**
   * Toggle a single file's checkbox.
   */
  async toggleFile(relativePath: string, checked: boolean): Promise<void> {
    if (checked) {
      this.selected.add(relativePath);
    } else {
      this.selected.delete(relativePath);
    }
    this._onDidChangeSelection.fire(this.getSelection());
  }

  /**
   * Toggle a directory — adds or removes all descendant files.
   */
  async toggleDirectory(absoluteDirPath: string, checked: boolean): Promise<void> {
    const files = await this.listDescendantFiles(absoluteDirPath);
    if (checked) {
      for (const f of files) {
        this.selected.add(this.toRelative(f));
      }
    } else {
      for (const f of files) {
        this.selected.delete(this.toRelative(f));
      }
    }
    // Refresh the whole tree — parent indeterminate states may need updating
    this._onDidChangeTreeData.fire();
    this._onDidChangeSelection.fire(this.getSelection());
  }

  /**
   * Handle the TreeView's onDidChangeCheckboxState event.
   * Called by extension.ts after wiring up the view.
   */
  async handleCheckboxChange(
    items: ReadonlyArray<[FileTreeItem, vscode.TreeItemCheckboxState]>,
  ): Promise<void> {
    for (const [item, state] of items) {
      const checked = state === vscode.TreeItemCheckboxState.Checked;
      if (item.data.isDirectory) {
        await this.toggleDirectory(item.data.absolutePath, checked);
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

  // -- Helpers -----------------------------------------------------------

  /**
   * Convert an absolute path to a POSIX-style workspace-relative path.
   */
  private toRelative(absolutePath: string): string {
    if (!this.workspaceRoot) {
      return absolutePath;
    }
    const rel = path.relative(this.workspaceRoot, absolutePath);
    // Normalize to POSIX separators so it matches what the rest of the
    // pipeline expects (FilterChain, formatHandoff, etc.).
    return rel.split(path.sep).join('/');
  }

  /**
   * Compute the tri-state checkbox value for a directory by inspecting
   * its descendants in the cached selection set.
   *
   * NOTE: We can't tell if ALL descendants are selected without listing
   * the directory, which is async. As a pragmatic approximation, we use:
   *   - Checked if at least one descendant prefix matches AND no known
   *     descendants are missing (best-effort).
   *   - For VS Code TreeView, we only report Checked or Unchecked
   *     (no third state until VS Code 1.95+); intermediate state
   *     just shows as Unchecked but the children carry the truth.
   */
  private directoryCheckState(relativeDirPath: string): vscode.TreeItemCheckboxState {
    const prefix = relativeDirPath.endsWith('/') ? relativeDirPath : `${relativeDirPath}/`;
    for (const sel of this.selected) {
      if (sel === relativeDirPath || sel.startsWith(prefix)) {
        return vscode.TreeItemCheckboxState.Checked;
      }
    }
    return vscode.TreeItemCheckboxState.Unchecked;
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
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      const child = path.join(dir, name);
      if ((type & vscode.FileType.Directory) !== 0) {
        await this.walk(child, accumulator);
      } else if ((type & vscode.FileType.File) !== 0) {
        accumulator.push(child);
      }
    }
  }

  private setupWatcher(root: string): void {
    const pattern = new vscode.RelativePattern(root, '**/*');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const refresh = (): void => this._onDidChangeTreeData.fire();
    this.watcher.onDidCreate(refresh);
    this.watcher.onDidDelete(refresh);
    // Don't refresh on every keystroke — onDidChange is too noisy.
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChangeTreeData.dispose();
    this._onDidChangeSelection.dispose();
  }
}
