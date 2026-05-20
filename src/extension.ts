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
  const treeProvider = new FileTreeProvider(workspaceRoot, initialSelection);
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
        break;
      case 'formatChange':
        session.currentFormat = msg.format;
        await refreshPanel(treeProvider, actionPanel, session, workspaceRoot);
        break;
      case 'instructionsChange':
        session.currentInstructions = msg.text;
        break;
      case 'overrideFile':
        session.overriddenPaths.add(msg.path);
        // Add the overridden path to the selection too, so it actually
        // gets included on next generate.
        const sel = new Set(treeProvider.getSelection());
        sel.add(msg.path);
        await treeProvider.setSelection(Array.from(sel));
        break;
      case 'generate':
        await runGenerate(treeProvider, actionPanel, session, workspaceRoot);
        break;
      case 'showAll':
        // Future: support paginated skipped lists
        break;
    }
  });

  // -- Commands --
  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('aiHandoff.generateFromExplorer', async (
      ...args: unknown[]
    ) => {
      const paths = collectExplorerPaths(args, workspaceRoot);
      if (paths.length === 0) {
        vscode.window.showWarningMessage('AI Handoff: no files selected.');
        return;
      }
      await treeProvider.setSelection(paths);
      await runGenerate(treeProvider, actionPanel, session, workspaceRoot);
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
  const selectedFiles: SelectedFile[] = selection.map((rel) => ({
    relativePath: rel,
    absolutePath: path.join(workspaceRoot, rel),
  }));

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
 * Generate the handoff for the current selection and dispatch to the
 * user's chosen destination(s).
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

  panel.setBusy(true);
  try {
    const selectedFiles: SelectedFile[] = selection.map((rel) => ({
      relativePath: rel,
      absolutePath: path.join(workspaceRoot, rel),
    }));
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

    // Refresh panel to show updated skipped list
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
 * Extract file/folder URIs from the explorer right-click context.
 * VS Code passes either a single Uri or a Uri + array of selected Uris.
 */
function collectExplorerPaths(args: unknown[], workspaceRoot: string | undefined): string[] {
  if (!workspaceRoot) {
    return [];
  }
  const uris: vscode.Uri[] = [];
  // arg 0 is the clicked Uri; arg 1 is the multi-select array (if any).
  if (args[0] && typeof args[0] === 'object' && 'fsPath' in (args[0] as object)) {
    uris.push(args[0] as vscode.Uri);
  }
  if (Array.isArray(args[1])) {
    for (const u of args[1]) {
      if (u && typeof u === 'object' && 'fsPath' in u) {
        uris.push(u as vscode.Uri);
      }
    }
  }
  // Dedupe and convert to POSIX-relative.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const u of uris) {
    const abs = u.fsPath;
    if (!abs.startsWith(workspaceRoot)) {
      continue;
    }
    const rel = path
      .relative(workspaceRoot, abs)
      .split(path.sep)
      .join('/');
    if (rel && !seen.has(rel)) {
      seen.add(rel);
      result.push(rel);
    }
  }
  return result;
}
