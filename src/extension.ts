/**
 * AI Handoff — extension entry point.
 *
 * Wires together:
 *   - TreeView (FileTreeProvider) on the sidebar
 *   - Webview action panel (ActionPanelProvider) below it
 *   - Command handlers for explorer right-click and panel button
 *   - Selection persistence (SelectionStore)
 *   - Output dispatch (clipboard / file / tab)
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { formatBytes } from './core/filter';
import { formatTokenCount } from './core/token-estimator';
import type {
  HandoffOptions,
  OutputFormat,
  SelectedFile,
  SelectionMemoryMode,
} from './core/types';
import { generateHandoff } from './services/handoff-generator';
import { SelectionStore } from './services/selection-store';
import { ActionPanelProvider, formatStatsForPanel } from './ui/action-panel';
import { FileTreeProvider } from './ui/file-tree-provider';
import { dispatchHandoff, pickDestinations } from './ui/output-picker';

// In-memory transient state — not persisted, lives for the session
interface SessionState {
  currentFormat: OutputFormat;
  currentInstructions: string;
  overriddenPaths: Set<string>;
  lastSkipped: Array<{ relativePath: string; reason: string; detail?: string }>;
}

export function activate(context: vscode.ExtensionContext): void {
  // Safety net: throw immediately if anything tries to make a network call.
  // This extension is fully offline — no telemetry, no API calls, nothing.
  enforceOffline();

  const workspaceRoot = getWorkspaceRoot();
  const store = new SelectionStore(context.workspaceState);

  // Load persisted last selection if enabled
  const memoryMode = getConfig<SelectionMemoryMode>('selectionMemory', 'lastOnly');
  const initialSelection =
    memoryMode === 'lastOnly' || memoryMode === 'both'
      ? store.getLastSelection() ?? []
      : [];

  const initialFormat = getConfig<OutputFormat>('outputFormat', 'xml');

  const session: SessionState = {
    currentFormat: initialFormat,
    currentInstructions: '',
    overriddenPaths: new Set(),
    lastSkipped: [],
  };

  // -- Tree provider --
  // Pass every workspace folder (not just the first) so multi-root
  // workspaces can select files from all of them, not just folders[0].
  const treeProvider = new FileTreeProvider(vscode.workspace.workspaceFolders, initialSelection);
  const treeView = vscode.window.createTreeView('aiHandoff.fileTree', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    canSelectMany: false,
  });
  // Native checkbox events
  treeView.onDidChangeCheckboxState(async (e) => {
    await treeProvider.handleCheckboxChange(e.items);
  });

  // -- Action panel --
  const actionPanel = new ActionPanelProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ActionPanelProvider.viewType, actionPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // -- React to selection changes by updating the panel stats --
  treeProvider.onDidChangeSelection(async (selected) => {
    if (memoryMode === 'lastOnly' || memoryMode === 'both') {
      await store.setLastSelection(selected);
    }
    await refreshPanel(treeProvider, actionPanel, session, workspaceRoot);
  });

  // -- React to panel events --
  actionPanel.onDidReceive(async (msg) => {
    switch (msg.type) {
      case 'ready':
        await refreshPanel(treeProvider, actionPanel, session, workspaceRoot);
        actionPanel.postBookmarks(store.listNamedSets());
        break;
      case 'formatChange':
        session.currentFormat = msg.format;
        await refreshPanel(treeProvider, actionPanel, session, workspaceRoot);
        break;
      case 'instructionsChange':
        session.currentInstructions = msg.text;
        break;
      case 'overrideFile': {
        session.overriddenPaths.add(msg.path);
        // Add the overridden path to the selection too, so it actually
        // gets included on next generate.
        const sel = new Set(treeProvider.getSelection());
        sel.add(msg.path);
        await treeProvider.setSelection(Array.from(sel));
        break;
      }
      case 'generate':
        await runGenerate(treeProvider, actionPanel, session, workspaceRoot);
        break;
      case 'showAll':
        // Future: support paginated skipped lists
        break;
      case 'saveBookmark': {
        const current = treeProvider.getSelection();
        if (current.length === 0) {
          vscode.window.showWarningMessage('AI Handoff: nothing to bookmark (no files selected).');
          break;
        }
        const name = await vscode.window.showInputBox({
          prompt: 'Name for this bookmark',
          placeHolder: 'e.g. "Auth module" or "API layer"',
          validateInput: (v) => (v.trim().length === 0 ? 'Name cannot be empty' : null),
        });
        if (!name) {
          break;
        }
        const existing = store.getNamedSet(name);
        if (existing) {
          const confirm = await vscode.window.showWarningMessage(
            `AI Handoff: "${name}" already exists. Overwrite?`,
            { modal: true },
            'Overwrite',
          );
          if (confirm !== 'Overwrite') {
            break;
          }
        }
        await store.saveNamedSet(name, current);
        vscode.window.showInformationMessage(`AI Handoff: bookmark "${name}" saved (${current.length} files).`);
        actionPanel.postBookmarks(store.listNamedSets());
        break;
      }
      case 'loadBookmark': {
        const paths = store.getNamedSet(msg.name) ?? [];
        await treeProvider.setSelection(paths);
        break;
      }
      case 'overrideBookmark': {
        const current = treeProvider.getSelection();
        if (current.length === 0) {
          vscode.window.showWarningMessage('AI Handoff: nothing to override with (no files selected).');
          break;
        }
        await store.saveNamedSet(msg.name, current);
        vscode.window.showInformationMessage(`AI Handoff: bookmark "${msg.name}" updated (${current.length} files).`);
        actionPanel.postBookmarks(store.listNamedSets());
        break;
      }
      case 'deleteBookmark': {
        await store.deleteNamedSet(msg.name);
        actionPanel.postBookmarks(store.listNamedSets());
        break;
      }
    }
  });

  // -- Commands --
  context.subscriptions.push(
    treeView,
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
      await doGenerateAndDispatch(files, actionPanel, session, root);
    }),
    vscode.commands.registerCommand('aiHandoff.generateFromPanel', async () => {
      await runGenerate(treeProvider, actionPanel, session, workspaceRoot);
    }),
    vscode.commands.registerCommand('aiHandoff.refreshTree', () => {
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('aiHandoff.clearSelection', async () => {
      await treeProvider.clearSelection();
      session.overriddenPaths.clear();
    }),
    vscode.commands.registerCommand('aiHandoff.saveSelectionSet', async () => {
      const current = treeProvider.getSelection();
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
      await treeProvider.setSelection(paths);
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

function getConfig<T>(key: string, defaultValue: T): T {
  return vscode.workspace.getConfiguration('aiHandoff').get<T>(key, defaultValue);
}

function getHandoffOptions(session: SessionState): HandoffOptions {
  return {
    format: session.currentFormat,
    includeLineNumbers: getConfig('includeLineNumbers', false),
    maxFileSizeKB: getConfig('maxFileSizeKB', 1024),
    respectGitignore: getConfig('respectGitignore', true),
    smartFilter: getConfig('smartFilter', true),
    customIgnorePatterns: getConfig<string[]>('customIgnorePatterns', []),
    binaryHandling: getConfig('binaryHandling', 'placeholder'),
    tokenEstimationRatio: getConfig('tokenEstimationRatio', 4),
    customInstructions: getConfig('showCustomInstructions', false)
      ? session.currentInstructions
      : undefined,
    overriddenPaths: Array.from(session.overriddenPaths),
  };
}

/**
 * Recompute stats for the panel based on the current selection.
 * Runs a "dry" pipeline pass — generates the handoff text just to
 * count files/size/tokens. Cheap enough for small projects.
 */
async function refreshPanel(
  treeProvider: FileTreeProvider,
  panel: ActionPanelProvider,
  session: SessionState,
  workspaceRoot: string | undefined,
): Promise<void> {
  if (!workspaceRoot) {
    panel.updateState({
      stats: formatStatsForPanel({ fileCount: 0, totalSizeBytes: 0, estimatedTokens: 0 }) as never,
      format: session.currentFormat,
      showCustomInstructions: getConfig('showCustomInstructions', false),
      instructions: session.currentInstructions,
      skipped: [],
    });
    return;
  }

  const selection = treeProvider.getSelection();
  const selectedFiles: SelectedFile[] = selection
    .map((rel) => {
      const absolutePath = treeProvider.resolveAbsolutePath(rel);
      return absolutePath ? { relativePath: rel, absolutePath } : undefined;
    })
    .filter((f): f is SelectedFile => f !== undefined);

  const opts = getHandoffOptions(session);
  const result = await generateHandoff(selectedFiles, opts, workspaceRoot);

  session.lastSkipped = result.skipped.map((s) => ({
    relativePath: s.relativePath,
    reason: s.reason,
    detail: s.detail,
  }));

  panel.updateState({
    stats: formatStatsForPanel(result.stats) as never,
    format: session.currentFormat,
    showCustomInstructions: getConfig('showCustomInstructions', false),
    instructions: session.currentInstructions,
    skipped: session.lastSkipped,
  });
}

/**
 * Core generate+dispatch pipeline. Called by both the panel button and the
 * Explorer right-click handler so the logic lives in one place.
 */
async function doGenerateAndDispatch(
  selectedFiles: SelectedFile[],
  panel: ActionPanelProvider,
  session: SessionState,
  workspaceRoot: string,
): Promise<void> {
  panel.setBusy(true);
  try {
    const opts = getHandoffOptions(session);
    const result = await generateHandoff(selectedFiles, opts, workspaceRoot);

    if (result.included.length === 0) {
      panel.showError(
        'No files made it through the filter. Check the skipped list and use [include anyway] to override.',
      );
      session.lastSkipped = result.skipped.map((s) => ({
        relativePath: s.relativePath,
        reason: s.reason,
        detail: s.detail,
      }));
      panel.updateState({
        stats: formatStatsForPanel(result.stats) as never,
        skipped: session.lastSkipped,
      });
      return;
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

    session.lastSkipped = result.skipped.map((s) => ({
      relativePath: s.relativePath,
      reason: s.reason,
      detail: s.detail,
    }));
    panel.updateState({
      stats: formatStatsForPanel(result.stats) as never,
      skipped: session.lastSkipped,
    });
  } catch (e) {
    panel.showError((e as Error).message);
    vscode.window.showErrorMessage(`AI Handoff: ${(e as Error).message}`);
  } finally {
    panel.setBusy(false);
  }
}

/**
 * Generate the handoff for the sidebar tree selection and dispatch it.
 */
async function runGenerate(
  treeProvider: FileTreeProvider,
  panel: ActionPanelProvider,
  session: SessionState,
  workspaceRoot: string | undefined,
): Promise<void> {
  if (!workspaceRoot) {
    panel.showError('No workspace folder is open.');
    return;
  }

  const selection = treeProvider.getSelection();
  if (selection.length === 0) {
    panel.showError('Select at least one file before generating.');
    return;
  }

  const selectedFiles: SelectedFile[] = selection
    .map((rel) => {
      const absolutePath = treeProvider.resolveAbsolutePath(rel);
      return absolutePath ? { relativePath: rel, absolutePath } : undefined;
    })
    .filter((f): f is SelectedFile => f !== undefined);

  await doGenerateAndDispatch(selectedFiles, panel, session, workspaceRoot);
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
