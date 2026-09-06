/**
 * AI Handoff — extension entry point.
 *
 * Wires together:
 *   - The merged sidebar webview (HandoffPanelProvider): search + virtualized
 *     file tree + actions footer, all backed by FileTreeModel
 *   - Command handlers for explorer/editor right-click and the command palette
 *   - Selection persistence (SelectionStore)
 *   - Output dispatch (clipboard / file / tab)
 *
 * This used to also wire up three legacy views (a native TreeView, a
 * standalone search-bar webview, and a separate actions webview) alongside
 * the merged one during the webview-merge rewrite. That cutover is done —
 * FileTreeModel/HandoffPanelProvider are the only tree/actions
 * implementation left, see git history (`feature/tree-search-webview-merge`)
 * for how it got here.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { formatBytes } from './core/filter';
import { formatTokenCount } from './core/token-estimator';
import type {
  DiffScope,
  HandoffOptions,
  OutputFormat,
  SelectedFile,
  SelectionMemoryMode,
} from './core/types';
import { FileTreeModel } from './services/file-tree-model';
import { RepoRootCache } from './services/git-diff-reader';
import { generateHandoff } from './services/handoff-generator';
import { SelectionStore } from './services/selection-store';
import { HandoffPanelProvider } from './ui/handoff-panel';
import { dispatchHandoff, pickDestinations } from './ui/output-picker';

export function activate(context: vscode.ExtensionContext): void {
  // Safety net: throw immediately if anything tries to make a network call.
  // This extension is fully offline — no telemetry, no API calls, nothing.
  enforceOffline();

  const workspaceRoot = getWorkspaceRoot();
  const store = new SelectionStore(context.workspaceState);

  // Load persisted last selection if enabled — the one thing FileTreeModel
  // couldn't inherit for free while the legacy Files view was still around
  // sharing the same persisted `aiHandoff.selectionMemory` state (it started
  // empty on every launch to avoid silently reappearing with stale
  // checkboxes). Now that this is the only tree, it owns both reading this
  // at startup (here) and writing it on every change (HandoffPanelProvider's
  // own selection listener).
  const memoryMode = getConfig<SelectionMemoryMode>('selectionMemory', 'lastOnly');
  const initialSelection =
    memoryMode === 'lastOnly' || memoryMode === 'both' ? store.getLastSelection() ?? [] : [];

  // Repo layouts rarely change mid-session, so git diff's nested-repo
  // discovery is cached. HandoffPanelProvider owns its own instance (used
  // for the tree's own Generate button); this one is for the standalone
  // explorer/editor-context generate commands below, which don't go through
  // the panel at all.
  const adHocRepoRootCache = new RepoRootCache();

  const fileTreeModel = new FileTreeModel(
    vscode.workspace.workspaceFolders,
    initialSelection,
    getConfig('searchSkipJunkDirs', true),
    getConfig('searchExcludeDirs', ''),
  );
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'AI Handoff: indexing files for search…' },
    () => fileTreeModel.buildSearchIndex(),
  );

  const handoffPanel = new HandoffPanelProvider(context.extensionUri, fileTreeModel, store, workspaceRoot);
  context.subscriptions.push(
    fileTreeModel,
    vscode.window.registerWebviewViewProvider(HandoffPanelProvider.viewType, handoffPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Mirrors FileTreeModel's "show selected only" state into a context key so
  // the view/title menu can swap between the two showSelectedOnlyOn/Off
  // icons — VS Code menu entries can't reflect a toggled/pressed state
  // directly, only be shown/hidden via `when`. Reacts to onDidChangeTree
  // (not a dedicated event) since collapseAll() can also turn this off
  // internally (it force-auto-expands ancestors, so collapsing while it's
  // still on would look like a no-op) — this keeps the icon in sync
  // regardless of what actually changed the underlying state.
  void vscode.commands.executeCommand('setContext', 'aiHandoff.showSelectedOnly', false);
  context.subscriptions.push(
    fileTreeModel.onDidChangeTree(() => {
      void vscode.commands.executeCommand(
        'setContext',
        'aiHandoff.showSelectedOnly',
        fileTreeModel.getShowSelectedOnly(),
      );
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiHandoff.searchSkipJunkDirs')) {
        void fileTreeModel.setSkipJunkInIndex(getConfig('searchSkipJunkDirs', true));
      }
      if (e.affectsConfiguration('aiHandoff.searchExcludeDirs')) {
        void fileTreeModel.setSearchExcludeDirs(getConfig('searchExcludeDirs', ''));
      }
    }),
  );

  // -- Commands --
  context.subscriptions.push(
    vscode.commands.registerCommand('aiHandoff.generateFromExplorer', async (
      ...args: unknown[]
    ) => {
      const files = collectExplorerFiles(args);
      if (files.length === 0) {
        vscode.window.showWarningMessage('AI Handoff: no files selected.');
        return;
      }
      // Use the primary workspace root for .gitignore / tree label context.
      // Each SelectedFile already carries the correct absolutePath regardless
      // of which workspace folder it belongs to.
      const root = workspaceRoot ?? files[0].absolutePath;
      await doGenerateAndDispatch(files, root, adHocRepoRootCache);
    }),
    vscode.commands.registerCommand('aiHandoff.generateFromExplorerBase64', async (
      ...args: unknown[]
    ) => {
      const files = collectExplorerFiles(args);
      if (files.length === 0) {
        vscode.window.showWarningMessage('AI Handoff: no files selected.');
        return;
      }
      const root = workspaceRoot ?? files[0].absolutePath;
      await doGenerateAndDispatch(files, root, adHocRepoRootCache, true);
    }),
    vscode.commands.registerCommand('aiHandoff.generateFromEditor', async (
      ...args: unknown[]
    ) => {
      // editor/context and editor/title/context both pass the resource URI
      // as an argument, same as explorer/context — but fall back to the
      // active editor's document just in case a host ever invokes this
      // without one (e.g. run via the command palette). collectExplorerFiles
      // dedupes by absolutePath, so appending the fallback is harmless even
      // when the menu-supplied arg is already present.
      const fallback = vscode.window.activeTextEditor?.document.uri;
      const files = collectExplorerFiles(fallback ? [...args, fallback] : args);
      if (files.length === 0) {
        vscode.window.showWarningMessage('AI Handoff: no file to generate from.');
        return;
      }
      const root = workspaceRoot ?? files[0].absolutePath;
      await doGenerateAndDispatch(files, root, adHocRepoRootCache);
    }),
    vscode.commands.registerCommand('aiHandoff.generateFromEditorBase64', async (
      ...args: unknown[]
    ) => {
      const fallback = vscode.window.activeTextEditor?.document.uri;
      const files = collectExplorerFiles(fallback ? [...args, fallback] : args);
      if (files.length === 0) {
        vscode.window.showWarningMessage('AI Handoff: no file to generate from.');
        return;
      }
      const root = workspaceRoot ?? files[0].absolutePath;
      await doGenerateAndDispatch(files, root, adHocRepoRootCache, true);
    }),
    vscode.commands.registerCommand('aiHandoff.generateFromSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('AI Handoff: no text selected.');
        return;
      }
      const uri = editor.document.uri;
      const absolutePath = uri.fsPath;
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) {
        vscode.window.showWarningMessage('AI Handoff: file is outside the workspace.');
        return;
      }
      const relativePath = path.relative(folder.uri.fsPath, absolutePath).split(path.sep).join('/');

      // VS Code selections are 0-indexed; convert to a 1-indexed inclusive
      // line range. If the selection ends at column 0 of a later line (e.g.
      // the user dragged from mid-line into the start of the next one),
      // that next line isn't actually highlighted — don't count it.
      const { selection } = editor;
      let endLine = selection.end.line;
      if (selection.end.character === 0 && endLine > selection.start.line) {
        endLine -= 1;
      }
      const lineRange = { start: selection.start.line + 1, end: endLine + 1 };

      const root = workspaceRoot ?? absolutePath;
      await doGenerateAndDispatch([{ relativePath, absolutePath, lineRange }], root, adHocRepoRootCache);
    }),
    vscode.commands.registerCommand('aiHandoff.generateFromPanel', async () => {
      await handoffPanel.runGenerate();
    }),
    vscode.commands.registerCommand('aiHandoff.refreshTree', () => {
      handoffPanel.refresh();
      adHocRepoRootCache.invalidate();
    }),
    vscode.commands.registerCommand('aiHandoff.clearSelection', async () => {
      await fileTreeModel.clearSelection();
    }),
    vscode.commands.registerCommand('aiHandoff.collapseAllTree', () => {
      fileTreeModel.collapseAll();
    }),
    vscode.commands.registerCommand('aiHandoff.showSelectedOnlyOn', () => {
      fileTreeModel.setShowSelectedOnly(true);
    }),
    vscode.commands.registerCommand('aiHandoff.showSelectedOnlyOff', () => {
      fileTreeModel.setShowSelectedOnly(false);
    }),
    vscode.commands.registerCommand('aiHandoff.saveSelectionSet', async () => {
      const current = fileTreeModel.getSelection();
      if (current.length === 0) {
        vscode.window.showWarningMessage('AI Handoff: nothing to save (no files selected).');
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: 'Name for this selection set',
        placeHolder: 'e.g. "Auth module" or "API layer"',
        validateInput: (v) => (v.trim().length === 0 ? 'Name cannot be empty' : null),
      });
      if (!name) {
        return;
      }
      try {
        await store.saveNamedSet(name, current);
        vscode.window.showInformationMessage(`AI Handoff: saved "${name}" (${current.length} files).`);
      } catch (e) {
        vscode.window.showErrorMessage(`AI Handoff: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('aiHandoff.loadSelectionSet', async () => {
      const names = store.listSetNames();
      if (names.length === 0) {
        vscode.window.showInformationMessage('AI Handoff: no saved selection sets yet.');
        return;
      }
      const items = names.map((n) => {
        const paths = store.getNamedSet(n) ?? [];
        return { label: n, description: `${paths.length} file${paths.length === 1 ? '' : 's'}` };
      });
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Pick a saved selection set to load',
      });
      if (!pick) {
        return;
      }
      const paths = store.getNamedSet(pick.label) ?? [];
      await fileTreeModel.setSelection(paths);
    }),
    vscode.commands.registerCommand('aiHandoff.deleteSelectionSet', async () => {
      const names = store.listSetNames();
      if (names.length === 0) {
        vscode.window.showInformationMessage('AI Handoff: no saved selection sets.');
        return;
      }
      const pick = await vscode.window.showQuickPick(names, {
        placeHolder: 'Pick a saved selection set to delete',
      });
      if (!pick) {
        return;
      }
      await store.deleteNamedSet(pick);
      vscode.window.showInformationMessage(`AI Handoff: deleted "${pick}".`);
    }),
  );

  console.log('[AI Handoff] activated');
}

export function deactivate(): void {
  // No cleanup needed beyond disposal of context.subscriptions.
}

// ---------------------------------------------------------------------
// Offline enforcement
// ---------------------------------------------------------------------

/**
 * Patch the global environment so any accidental network call throws
 * immediately with a clear message, rather than silently succeeding or
 * failing with a cryptic network error.
 *
 * Covers:
 *   - globalThis.fetch  (browser-style fetch, available in newer Node/VS Code)
 *   - globalThis.XMLHttpRequest  (unlikely in Node, but belt-and-suspenders)
 */
function enforceOffline(): void {
  const msg =
    '[AI Handoff] Network access is disabled — this extension is fully offline. ' +
    'No data ever leaves your machine.';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;

  // Override fetch if it exists in the global scope
  if (typeof g.fetch === 'function') {
    g.fetch = (): never => { throw new Error(msg); };
  }

  // Override XMLHttpRequest if it exists
  if (typeof g.XMLHttpRequest !== 'undefined') {
    g.XMLHttpRequest = class {
      open(): never { throw new Error(msg); }
      send(): never { throw new Error(msg); }
    };
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return folders[0].uri.fsPath;
}

/** Every workspace folder, as plain data — used for per-repo git diff discovery. */
function getWorkspaceFolders(): { name: string; path: string }[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath }));
}

function getConfig<T>(key: string, defaultValue: T): T {
  return vscode.workspace.getConfiguration('aiHandoff').get<T>(key, defaultValue);
}

/**
 * HandoffOptions for the standalone explorer/editor-context generate
 * commands, which don't go through the merged panel (and so have no live
 * "session" to read a chosen format/diff-toggle/overrides from) — reads
 * fresh from configured defaults every time, same as HandoffPanelProvider's
 * own constructor does at startup. A deliberate simplification: these
 * commands act on an explicit one-off file (or selection), not the tree, so
 * there's no natural "current session settings" for them to inherit from —
 * unlike aiHandoff.generateFromPanel, which now goes through
 * HandoffPanelProvider.runGenerate() and its own live state instead.
 */
function getAdHocHandoffOptions(base64Encode = false): HandoffOptions {
  return {
    format: getConfig<OutputFormat>('outputFormat', 'xml'),
    includeLineNumbers: getConfig('includeLineNumbers', false),
    maxFileSizeKB: getConfig('maxFileSizeKB', 1024),
    respectGitignore: getConfig('respectGitignore', true),
    smartFilter: getConfig('smartFilter', true),
    customIgnorePatterns: getConfig<string[]>('customIgnorePatterns', []),
    binaryHandling: getConfig('binaryHandling', 'placeholder'),
    tokenEstimationRatio: getConfig('tokenEstimationRatio', 4),
    customInstructions: undefined,
    overriddenPaths: [],
    gitDiff: {
      enabled: getConfig('gitDiffEnabledByDefault', false),
      scope: getConfig<DiffScope>('gitDiffScope', 'working'),
    },
    base64Encode,
  };
}

/**
 * Core generate+dispatch pipeline for the standalone explorer/editor-context
 * commands (generateFromExplorer/generateFromEditor/generateFromSelection) —
 * these don't have a panel to show busy/error state in, so progress and
 * errors surface via vscode.window's own notification APIs instead.
 */
async function doGenerateAndDispatch(
  selectedFiles: SelectedFile[],
  workspaceRoot: string,
  repoRootCache: RepoRootCache,
  base64Encode = false,
): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'AI Handoff: generating…' },
    async () => {
      try {
        const opts = getAdHocHandoffOptions(base64Encode);
        const result = await generateHandoff(
          selectedFiles,
          opts,
          workspaceRoot,
          getWorkspaceFolders(),
          repoRootCache,
        );
        const hasDiffContent = (result.diff?.files.length ?? 0) > 0;

        if (result.included.length === 0 && !hasDiffContent) {
          vscode.window.showWarningMessage(
            'AI Handoff: no files made it through the filter. Check the skipped list and use [include anyway] to override.',
          );
          return;
        }

        if (result.diff?.error) {
          const message =
            result.diff.error === 'git-not-found'
              ? 'git was not found on PATH — diff skipped.'
              : 'No git repository found in this workspace — diff skipped.';
          vscode.window.showWarningMessage(`AI Handoff: ${message}`);
        }

        const destinations = await pickDestinations();
        if (destinations.length === 0) {
          return;
        }

        const messages = await dispatchHandoff(result.text, opts.format, destinations);
        const summary =
          `AI Handoff: ${result.stats.fileCount} files, ` +
          `${formatBytes(result.stats.totalSizeBytes)}, ` +
          `~${formatTokenCount(result.stats.estimatedTokens)} tokens. ` +
          messages.join('. ');
        vscode.window.showInformationMessage(summary);
      } catch (e) {
        vscode.window.showErrorMessage(`AI Handoff: ${(e as Error).message}`);
      }
    },
  );
}

/**
 * Return the filesystem path from a value that is either a proper vscode.Uri
 * or a plain serialised URI object ({ scheme, path, ... }) that VS Code can
 * pass before the extension host has revived it into a Uri instance.
 * Returns undefined if the value is not a file:// URI-like object.
 */
function tryGetFsPath(u: unknown): string | undefined {
  if (!u || typeof u !== 'object') {
    return undefined;
  }
  const o = u as Record<string, unknown>;
  // Proper vscode.Uri — fsPath is a computed string property on the instance.
  if (typeof o.fsPath === 'string') {
    return o.fsPath;
  }
  // Plain serialised object ({ $mid, scheme, path, ... }) — fsPath not yet
  // computed. On macOS/Linux the 'path' component equals fsPath for file URIs.
  if (o.scheme === 'file' && typeof o.path === 'string') {
    return o.path;
  }
  return undefined;
}

/**
 * Build a SelectedFile list from the Explorer right-click context args.
 *
 * VS Code passes arg0 = clicked Uri, arg1 = selection array, but the shape
 * varies (Uri instances vs plain serialised objects). We flatten all args,
 * use tryGetFsPath() to extract the filesystem path from either form, and
 * then use vscode.workspace.getWorkspaceFolder() to compute the correct
 * relative path for each file regardless of which workspace folder it lives in.
 */
function collectExplorerFiles(args: unknown[]): SelectedFile[] {
  // Flatten: handles both (uri, uriArray) and any variation in arg order.
  const raw: unknown[] = [];
  for (const arg of args) {
    if (Array.isArray(arg)) {
      raw.push(...arg);
    } else if (arg) {
      raw.push(arg);
    }
  }

  const seen = new Set<string>();
  const result: SelectedFile[] = [];
  for (const r of raw) {
    const absolutePath = tryGetFsPath(r);
    if (!absolutePath || seen.has(absolutePath)) {
      continue;
    }
    seen.add(absolutePath);

    // Find the workspace folder that owns this file.
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absolutePath));
    if (!folder) {
      continue; // Outside all workspace folders — skip.
    }

    const relativePath = path
      .relative(folder.uri.fsPath, absolutePath)
      .split(path.sep)
      .join('/');

    if (!relativePath || relativePath.startsWith('..')) {
      continue;
    }

    result.push({ relativePath, absolutePath });
  }
  return result;
}
