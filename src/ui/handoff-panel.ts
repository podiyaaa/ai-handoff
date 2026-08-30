/**
 * The merged sidebar webview — search input + a custom-rendered (virtualized)
 * file tree + the actions footer, all in one `WebviewViewProvider`, replacing
 * the three separately-chromed views (`aiHandoff.searchBar`,
 * `aiHandoff.fileTree`, `aiHandoff.actionPanel`) that used to live stacked in
 * the sidebar. See CLAUDE.md's architecture notes for why (VS Code enforces
 * a minimum resizable height per stacked view, wasting space the search
 * bar's single input row didn't need).
 *
 * Built up in stages (see the project's webview-merge plan) — virtualized
 * tree render, checkbox selection, search, file-open, and now the actions
 * footer (format/instructions/diff/generate/bookmarks/skipped) are all
 * wired up, against real `FileTreeModel` data. Registered *alongside* the
 * three old views (not replacing them) until the final cutover stage.
 *
 * This provider deliberately owns its own session-like state (format,
 * instructions, diff settings, overridden paths, a RepoRootCache) rather
 * than sharing `extension.ts`'s `SessionState`/legacy `ActionPanelProvider` —
 * the two systems' shapes (FileTreeProvider vs FileTreeModel,
 * ActionPanelProvider vs a bridge) differ enough that unifying them now
 * would just get unwound again at the stage 8 cutover, when the legacy
 * system is deleted and only this one remains. `SelectionStore` (bookmarks/
 * last-selection) IS shared — it's a stateless wrapper around
 * `context.workspaceState`, so passing in the same instance costs nothing
 * and keeps bookmarks consistent between old and new during the migration.
 *
 * Framework-free, no build step — same convention as `action-panel.ts`/
 * `search-bar-panel.ts`, just with the webview's JS split into external
 * files under `media/webview/` (loaded via `asWebviewUri()`) instead of one
 * inline template literal, since this view's client-side code (bridge
 * client, virtualization math, tree/search/actions rendering) is large
 * enough that a single inline string would hurt review/maintenance more
 * than a few extra files does.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import type { PanelBookmark, PanelState } from '../core/bridge-protocol';
import { formatBytes } from '../core/filter';
import { formatStatsForPanel } from '../core/formatter';
import { parseSearchQuery } from '../core/search-filter';
import { formatTokenCount } from '../core/token-estimator';
import type { DiffScope, HandoffOptions, OutputFormat, SelectedFile, SelectionMemoryMode } from '../core/types';
import type { FileTreeModel } from '../services/file-tree-model';
import { RepoRootCache } from '../services/git-diff-reader';
import { generateHandoff } from '../services/handoff-generator';
import type { SelectionStore } from '../services/selection-store';
import { dispatchHandoff, pickDestinations } from './output-picker';
import { HostBridge } from './webview-host-bridge';
import { generateNonce } from './webview-nonce';

export class HandoffPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aiHandoff.mainView';

  private bridge: HostBridge | undefined;

  // -- Session-like state — see the class doc for why this isn't shared
  // with extension.ts's SessionState.
  private currentFormat: OutputFormat;
  private currentInstructions = '';
  private readonly overriddenPaths = new Set<string>();
  private lastSkipped: Array<{ relativePath: string; reason: string; detail?: string }> = [];
  private gitDiffEnabled: boolean;
  private diffScope: DiffScope;
  private base64Encode = false;
  private readonly repoRootCache = new RepoRootCache();
  // computeState() does real fs I/O, so pushState() calls triggered in quick
  // succession (e.g. two toggleFile calls, or a toggle followed by a
  // bookmark load) can resolve out of order. Each call captures the current
  // generation and only emits if it's still the latest by the time its
  // computeState() resolves — otherwise a stale, already-superseded result
  // can land after a newer one and show the wrong stats for the actual
  // current selection.
  private stateGeneration = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly model: FileTreeModel,
    private readonly store: SelectionStore,
    private readonly workspaceRoot: string | undefined,
  ) {
    this.currentFormat = this.getConfig<OutputFormat>('outputFormat', 'xml');
    this.gitDiffEnabled = this.getConfig('gitDiffEnabledByDefault', false);
    this.diffScope = this.getConfig<DiffScope>('gitDiffScope', 'working');
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      // Covers both media/webview/ (bridge/render scripts) and
      // media/codicons/ (the bundled codicon font, for the tree's
      // expand/collapse chevrons — matching VS Code's own tree twisties
      // instead of plain Unicode triangles).
      localResourceRoots: [vscode.Uri.file(path.join(this.extensionUri.fsPath, 'media'))],
    };
    view.webview.html = this.renderHtml(view.webview);

    const bridge = new HostBridge(view.webview);
    this.bridge = bridge;
    this.registerHandlers(bridge);

    // Coarse (no diffing) but cheap: the model's own watcher-driven
    // debouncing already coalesces bursts, and getVisibleRows() is bounded
    // by what's actually expanded — so "just refetch everything" on any
    // change is fine, no need for finer-grained invalidation yet.
    const changeListener = this.model.onDidChangeTree(() => {
      bridge.emit('tree/invalidated', { path: undefined });
    });
    // Refresh stats whenever selection changes, and persist it as the "last
    // selection" for next launch — mirrors the old
    // treeProvider.onDidChangeSelection -> refreshPanel wiring, now including
    // the store.setLastSelection() persistence that was deliberately deferred
    // until this provider became the only one left (see extension.ts's
    // initialSelection computation, now wired into this provider's model too).
    const selectionListener = this.model.onDidChangeSelection((selected) => {
      const memoryMode = this.getConfig<SelectionMemoryMode>('selectionMemory', 'lastOnly');
      if (memoryMode === 'lastOnly' || memoryMode === 'both') {
        void this.store.setLastSelection(selected);
      }
      void this.pushState();
    });
    // Ticking one specific file's checkbox is a deliberate "include this
    // exact file" action, so auto-register it as a filter override — same
    // reasoning as the legacy treeProvider.onDidToggleIndividualFile wiring.
    const overrideListener = this.model.onDidToggleIndividualFile(({ relativePath, checked }) => {
      if (checked) {
        this.overriddenPaths.add(relativePath);
      } else {
        this.overriddenPaths.delete(relativePath);
      }
    });

    view.onDidDispose(() => {
      changeListener.dispose();
      selectionListener.dispose();
      overrideListener.dispose();
      bridge.dispose();
      if (this.bridge === bridge) {
        this.bridge = undefined;
      }
    });
  }

  private registerHandlers(bridge: HostBridge): void {
    bridge.handle('tree/getChildren', ({ path: relativePath }) => this.model.getChildren(relativePath));
    bridge.handle('tree/getVisibleRows', () => this.model.getVisibleRows());
    bridge.handle('tree/toggleExpand', ({ path: relativePath, expanded }) => {
      this.model.setExpanded(relativePath, expanded);
    });
    bridge.handle('tree/toggleFile', ({ path: relativePath, checked }) => this.model.toggleFile(relativePath, checked));
    bridge.handle('tree/toggleDirectory', ({ path: relativePath, checked }) =>
      this.model.toggleDirectory(relativePath, checked),
    );
    bridge.handle('tree/setSearchQuery', ({ text }) => {
      // On an invalid query (e.g. an unterminated regex while still
      // typing), surface the error and leave the last valid filter in
      // place, rather than clearing the model's query on every keystroke —
      // same behavior as the old search-bar-panel.ts wiring.
      const { query, error } = parseSearchQuery(text);
      if (!error) {
        this.model.setSearchQuery(query);
      }
      return { error };
    });
    bridge.handle('file/open', async ({ path: relativePath }) => {
      const absolutePath = this.model.resolveAbsolutePath(relativePath);
      if (!absolutePath) {
        return;
      }
      // Same command the old FileTreeItem's click behavior used
      // (vscode.open via a TreeItem.command), just invoked directly since
      // there's no TreeItem here to attach it to.
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absolutePath));
    });

    bridge.handle('actions/ready', async () => ({
      state: await this.computeState(),
      bookmarks: this.getBookmarks(),
    }));
    bridge.handle('actions/setFormat', ({ format }) => {
      this.currentFormat = format;
      void this.pushState();
    });
    bridge.handle('actions/setInstructions', ({ text }) => {
      this.currentInstructions = text;
    });
    bridge.handle('actions/setDiffEnabled', ({ enabled }) => {
      this.gitDiffEnabled = enabled;
      void this.pushState();
    });
    bridge.handle('actions/setDiffScope', ({ scope }) => {
      this.diffScope = scope;
      if (this.gitDiffEnabled) {
        void this.pushState();
      }
    });
    bridge.handle('actions/setBase64Encode', ({ enabled }) => {
      this.base64Encode = enabled;
      void this.pushState();
    });
    bridge.handle('actions/setLookForImports', ({ enabled }) => {
      this.model.setLookForImports(enabled);
      void this.pushState();
    });
    bridge.handle('actions/setImportsRecursive', ({ enabled }) => {
      this.model.setImportsRecursive(enabled);
      void this.pushState();
    });
    bridge.handle('actions/overrideFile', async ({ path: relativePath }) => {
      this.overriddenPaths.add(relativePath);
      // Add the overridden path to the selection too, so it actually gets
      // included on next generate. Fires onDidChangeSelection, which
      // already triggers pushState() via the listener above.
      const sel = new Set(this.model.getSelection());
      sel.add(relativePath);
      await this.model.setSelection(Array.from(sel));
    });
    bridge.handle('actions/generate', () => this.generate());

    bridge.handle('bookmarks/save', () => this.saveBookmark());
    bridge.handle('bookmarks/load', ({ name }) => this.loadBookmark(name));
    bridge.handle('bookmarks/delete', async ({ name }) => {
      await this.store.deleteNamedSet(name);
      this.pushBookmarks();
    });
    bridge.handle('bookmarks/overrideWithCurrent', ({ name }) => this.overrideBookmark(name));
  }

  // -- Config / options -----------------------------------------------------

  private getConfig<T>(key: string, defaultValue: T): T {
    return vscode.workspace.getConfiguration('aiHandoff').get<T>(key, defaultValue);
  }

  /** Every workspace folder, as plain data — used for per-repo git diff discovery. */
  private getWorkspaceFolders(): { name: string; path: string }[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath }));
  }

  private getHandoffOptions(): HandoffOptions {
    return {
      format: this.currentFormat,
      includeLineNumbers: this.getConfig('includeLineNumbers', false),
      maxFileSizeKB: this.getConfig('maxFileSizeKB', 1024),
      respectGitignore: this.getConfig('respectGitignore', true),
      smartFilter: this.getConfig('smartFilter', true),
      customIgnorePatterns: this.getConfig<string[]>('customIgnorePatterns', []),
      binaryHandling: this.getConfig('binaryHandling', 'placeholder'),
      tokenEstimationRatio: this.getConfig('tokenEstimationRatio', 4),
      customInstructions: this.getConfig('showCustomInstructions', false) ? this.currentInstructions : undefined,
      overriddenPaths: Array.from(this.overriddenPaths),
      gitDiff: { enabled: this.gitDiffEnabled, scope: this.diffScope },
      base64Encode: this.base64Encode,
    };
  }

  private getSelectedFiles(): SelectedFile[] {
    return this.model
      .getSelection()
      .map((relativePath) => {
        const absolutePath = this.model.resolveAbsolutePath(relativePath);
        return absolutePath ? { relativePath, absolutePath } : undefined;
      })
      .filter((f): f is SelectedFile => f !== undefined);
  }

  // -- State / bookmarks push ------------------------------------------------

  /**
   * Recompute stats for the footer based on the current selection. Runs a
   * "dry" pipeline pass — generates the handoff text just to count
   * files/size/tokens. Cheap enough for small projects (matches the old
   * refreshPanel's own tradeoff, unchanged here).
   */
  private async computeState(): Promise<PanelState> {
    const showCustomInstructions = this.getConfig('showCustomInstructions', false);
    if (!this.workspaceRoot) {
      return {
        stats: formatStatsForPanel({ fileCount: 0, totalSizeBytes: 0, estimatedTokens: 0, diffFileCount: 0 }),
        format: this.currentFormat,
        showCustomInstructions,
        instructions: this.currentInstructions,
        skipped: [],
        gitDiffEnabled: this.gitDiffEnabled,
        diffScope: this.diffScope,
        base64Encode: this.base64Encode,
        lookForImports: this.model.getLookForImports(),
        importsRecursive: this.model.getImportsRecursive(),
        hasWorkspace: false,
      };
    }

    const opts = this.getHandoffOptions();
    const result = await generateHandoff(
      this.getSelectedFiles(),
      opts,
      this.workspaceRoot,
      this.getWorkspaceFolders(),
      this.repoRootCache,
    );
    this.lastSkipped = result.skipped.map((s) => ({
      relativePath: s.relativePath,
      reason: s.reason,
      detail: s.detail,
    }));

    return {
      stats: formatStatsForPanel(result.stats),
      format: this.currentFormat,
      showCustomInstructions,
      instructions: this.currentInstructions,
      skipped: this.lastSkipped,
      gitDiffEnabled: this.gitDiffEnabled,
      diffScope: this.diffScope,
      base64Encode: this.base64Encode,
      lookForImports: this.model.getLookForImports(),
      importsRecursive: this.model.getImportsRecursive(),
      hasWorkspace: true,
    };
  }

  private async pushState(): Promise<void> {
    const generation = ++this.stateGeneration;
    const state = await this.computeState();
    if (generation !== this.stateGeneration) {
      // A newer pushState() call was made while this one was still
      // computing — its result is stale, discard it instead of overwriting
      // the newer (still in-flight or already-emitted) state.
      return;
    }
    this.bridge?.emit('state', state);
  }

  private getBookmarks(): PanelBookmark[] {
    const named = this.store.listNamedSets();
    return Object.entries(named).map(([name, paths]) => ({ name, fileCount: paths.length }));
  }

  private pushBookmarks(): void {
    this.bridge?.emit('bookmarks', this.getBookmarks());
  }

  // -- Generate ---------------------------------------------------------------

  /**
   * Exposed for the `aiHandoff.generateFromPanel` command-palette entry —
   * generates using the tree's current selection and this provider's own
   * live settings (format/diff/overrides), the same as clicking the
   * webview's own Generate button. Kept as a thin public wrapper rather
   * than making `generate()` itself public, so the class's intentional
   * surface (bridge handlers in, nothing else out) stays clear.
   */
  async runGenerate(): Promise<void> {
    await this.generate();
  }

  /**
   * Re-reads the tree and invalidates the git-diff repo-root cache (repo
   * layouts rarely change mid-session, so that discovery is normally
   * memoized) — exposed for the `aiHandoff.refreshTree` command, the manual
   * escape hatch for the rare case a repo got added/moved/removed since the
   * cache was built. Also refreshes stats, since a manual refresh can
   * surface files that weren't there when they were last computed.
   */
  refresh(): void {
    this.model.refresh();
    this.repoRootCache.invalidate();
    void this.pushState();
  }

  private async generate(): Promise<void> {
    if (!this.workspaceRoot) {
      this.bridge?.emit('error', { message: 'No workspace folder is open.' });
      return;
    }
    // Git diff is scoped to the current selection, so an empty selection
    // can't produce a diff-only handoff either — there'd be nothing for the
    // diff to match against (same reasoning as the legacy runGenerate).
    if (this.model.getSelection().length === 0) {
      this.bridge?.emit('error', { message: 'Select at least one file before generating.' });
      return;
    }

    this.bridge?.emit('actions/generating', { busy: true });
    try {
      const opts = this.getHandoffOptions();
      const result = await generateHandoff(
        this.getSelectedFiles(),
        opts,
        this.workspaceRoot,
        this.getWorkspaceFolders(),
        this.repoRootCache,
      );
      const hasDiffContent = (result.diff?.files.length ?? 0) > 0;

      if (result.included.length === 0 && !hasDiffContent) {
        this.bridge?.emit('error', {
          message: 'No files made it through the filter. Check the skipped list and use [include anyway] to override.',
        });
        await this.pushState();
        return;
      }

      if (result.diff?.error) {
        const message =
          result.diff.error === 'git-not-found'
            ? 'git was not found on PATH — diff skipped.'
            : 'No git repository found in this workspace — diff skipped.';
        this.bridge?.emit('error', { message });
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

      await this.pushState();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.bridge?.emit('error', { message });
      vscode.window.showErrorMessage(`AI Handoff: ${message}`);
    } finally {
      this.bridge?.emit('actions/generating', { busy: false });
    }
  }

  // -- Bookmarks ---------------------------------------------------------------

  private async saveBookmark(): Promise<void> {
    const current = this.model.getSelection();
    if (current.length === 0) {
      vscode.window.showWarningMessage('AI Handoff: nothing to bookmark (no files selected).');
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: 'Name for this bookmark',
      placeHolder: 'e.g. "Auth module" or "API layer"',
      validateInput: (v) => (v.trim().length === 0 ? 'Name cannot be empty' : null),
    });
    if (!name) {
      return;
    }
    const existing = this.store.getNamedSet(name);
    if (existing) {
      const confirm = await vscode.window.showWarningMessage(
        `AI Handoff: "${name}" already exists. Overwrite?`,
        { modal: true },
        'Overwrite',
      );
      if (confirm !== 'Overwrite') {
        return;
      }
    }
    await this.store.saveNamedSet(name, current);
    vscode.window.showInformationMessage(`AI Handoff: bookmark "${name}" saved (${current.length} files).`);
    this.pushBookmarks();
  }

  private async loadBookmark(name: string): Promise<void> {
    const paths = this.store.getNamedSet(name) ?? [];
    await this.model.setSelection(paths);
  }

  private async overrideBookmark(name: string): Promise<void> {
    const current = this.model.getSelection();
    if (current.length === 0) {
      vscode.window.showWarningMessage('AI Handoff: nothing to override with (no files selected).');
      return;
    }
    await this.store.saveNamedSet(name, current);
    vscode.window.showInformationMessage(`AI Handoff: bookmark "${name}" updated (${current.length} files).`);
    this.pushBookmarks();
  }

  // -- HTML ---------------------------------------------------------------

  private renderHtml(webview: vscode.Webview): string {
    const nonce = generateNonce();
    const mediaUri = (file: string): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.file(path.join(this.extensionUri.fsPath, 'media', 'webview', file)));
    const codiconFontUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.extensionUri.fsPath, 'media', 'codicons', 'codicon.ttf')),
    );

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Handoff</title>
  <style>
    * { box-sizing: border-box; }
    @font-face {
      font-family: 'codicon';
      src: url('${codiconFontUri}') format('truetype');
    }
    .codicon {
      font-family: 'codicon';
      font-size: 16px;
      display: inline-block;
      text-align: center;
      text-rendering: auto;
      -webkit-font-smoothing: antialiased;
    }
    html, body {
      height: 100%;
      margin: 0;
      padding: 0;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background: var(--vscode-sideBar-background, transparent);
    }
    .shell {
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    .search-header {
      flex: 0 0 auto;
      padding: 6px 12px;
    }
    .search-wrap {
      position: relative;
      display: flex;
      align-items: center;
    }
    .search-wrap input {
      width: 100%;
      padding: 4px 24px 4px 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .search-wrap input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .search-wrap input.invalid {
      border-color: var(--vscode-inputValidation-errorBorder);
    }
    .search-wrap button.clear {
      position: absolute;
      right: 3px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      padding: 0;
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      opacity: 0.6;
      cursor: pointer;
      border-radius: 2px;
      font-size: 12px;
      line-height: 1;
    }
    .search-wrap button.clear:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2));
    }
    .search-header .hint,
    .search-header .error {
      margin-top: 4px;
      font-size: 0.85em;
    }
    .search-header .hint { opacity: 0.6; }
    .search-header .error { color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground)); }
    .hidden { display: none !important; }
    #tree-scroll {
      flex: 1 1 auto;
      overflow-y: auto;
      position: relative;
    }
    #tree-spacer {
      position: relative;
    }
    #no-workspace {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      padding: 24px 16px;
      text-align: center;
      opacity: 0.7;
      font-size: 0.95em;
    }
    .tree-row {
      position: absolute;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      white-space: nowrap;
      overflow: hidden;
      cursor: default;
    }
    .tree-row-dir {
      cursor: pointer;
    }
    .tree-row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    /* Roving tabindex: exactly one row is ever tabindex="0" at a time (see
       tree-render.js's applyRovingTabindex), so this only ever shows on
       whichever row keyboard focus actually landed on. */
    .tree-row:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .tree-row-checkbox {
      flex: 0 0 auto;
      margin: 0 4px 0 0;
      cursor: pointer;
      /* Tints the native checkbox with the theme's accent color instead of
         the OS's unthemed default — same fix already used for the diff
         checkbox in action-panel.ts, for consistency across both webviews. */
      accent-color: var(--vscode-button-background);
    }
    /* :focus-visible (not :focus) — the browser's own heuristic only shows
       this for keyboard focus (Tab), not a mouse click, so ticking a
       checkbox with the mouse no longer shows any ring at all, while Tab
       navigation still does (needed for stage 7's accessibility pass —
       removing the indicator entirely would break keyboard-focus visibility). */
    .tree-row-checkbox:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .tree-row-icon {
      width: 16px;
      flex: 0 0 auto;
      opacity: 0.8;
    }
    .tree-row-label {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* -- Actions footer ---------------------------------------------------- */
    .actions-footer {
      flex: 0 0 auto;
      padding: 8px 12px;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
      max-height: 60vh;
      overflow-y: auto;
    }
    .stats {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 4px 12px;
      margin-bottom: 10px;
      padding: 6px 10px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
    }
    .stats .label { opacity: 0.7; }
    .stats .value { font-variant-numeric: tabular-nums; font-weight: 500; }
    .actions-footer label {
      display: block;
      margin: 8px 0 4px;
      opacity: 0.85;
    }
    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 8px 0 4px;
    }
    .checkbox-row label { margin: 0; opacity: 1; }
    .checkbox-row input[type="checkbox"] { accent-color: var(--vscode-button-background); }
    .actions-footer select,
    .actions-footer textarea {
      width: 100%;
      padding: 4px 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .actions-footer select:focus,
    .actions-footer textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .actions-footer textarea {
      min-height: 60px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .actions-footer button.primary {
      width: 100%;
      margin-top: 10px;
      padding: 6px 10px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      cursor: pointer;
    }
    .actions-footer button.primary:hover { background: var(--vscode-button-hoverBackground); }
    .actions-footer button.primary:disabled { opacity: 0.5; cursor: default; }
    .actions-footer button.secondary {
      width: 100%;
      margin-top: 6px;
      padding: 4px 10px;
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border: 1px solid var(--vscode-button-background);
      border-radius: 2px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      cursor: pointer;
    }
    .actions-footer button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-editor-inactiveSelectionBackground));
    }
    .actions-footer .error {
      margin-top: 8px;
      padding: 6px 10px;
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 2px;
      font-size: 0.9em;
    }
    /* Tier 2 — collapsible as a group: instructions + bookmarks + skipped. */
    .tier2-toggle {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
      cursor: pointer;
      opacity: 0.8;
      user-select: none;
    }
    .tier2-toggle:hover { opacity: 1; }
    .tier2-body.collapsed { display: none; }
    /* Bookmarks / Skipped files — each its own independently collapsible
       section with a bounded, separately-scrolling list, so a long list
       never grows the footer (and squeezes the tree) open-ended. */
    .subsection { margin-top: 10px; }
    .subsection-header {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      user-select: none;
      font-weight: 600;
      opacity: 0.85;
    }
    .subsection-header:hover { opacity: 1; }
    .subsection-body {
      margin-top: 4px;
      max-height: 180px;
      overflow-y: auto;
    }
    .subsection-body.collapsed { display: none; }
    .subsection-empty { opacity: 0.6; font-style: italic; font-size: 0.9em; }
    .subsection ul { list-style: none; padding: 0; margin: 0; }
    .subsection li {
      padding: 2px 0;
      display: flex;
      gap: 6px;
      align-items: baseline;
      font-size: 0.9em;
    }
    .bk-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bk-count { opacity: 0.55; font-size: 0.85em; flex-shrink: 0; }
    .subsection a.action {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      cursor: pointer;
      flex-shrink: 0;
    }
    .subsection a.action:hover { text-decoration: underline; }
    .subsection li .path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85; }
    .subsection li .detail { opacity: 0.55; font-size: 0.85em; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="search-header">
      <div class="search-wrap">
        <input
          id="query"
          type="text"
          placeholder="Search files… (ext:ts,tsx · re:^use[A-Z])"
          aria-label="Search files"
        />
        <button class="clear hidden" id="clear" title="Clear search" aria-label="Clear search">&#x2715;</button>
      </div>
      <div class="hint hidden" id="hint">Plain text matches the path — or try "ext:ts,tsx" / "re:^use[A-Z]".</div>
      <div class="error hidden" id="error"></div>
    </div>
    <div id="tree-scroll">
      <div id="no-workspace" class="hidden">No workspace folder is open — open a folder to select files.</div>
      <div id="tree-spacer" role="tree" aria-label="File tree" aria-multiselectable="true"></div>
    </div>

    <div class="actions-footer">
      <div class="stats" aria-label="Selection statistics">
        <span class="label">Files:</span>
        <span class="value" id="stat-files">0</span>
        <span class="label">Size:</span>
        <span class="value" id="stat-size">0 B</span>
        <span class="label">Tokens:</span>
        <span class="value" id="stat-tokens">~0</span>
        <span class="label hidden" id="stat-diff-label">Diff files:</span>
        <span class="value hidden" id="stat-diff-files">0</span>
      </div>

      <label for="format">Output format</label>
      <select id="format">
        <option value="xml">XML (best for AI)</option>
        <option value="markdown">Markdown</option>
        <option value="plain">Plain text</option>
      </select>

      <div class="checkbox-row">
        <input type="checkbox" id="base64-encode" />
        <label for="base64-encode">Base64 encode output</label>
      </div>

      <div class="checkbox-row">
        <input type="checkbox" id="diff-enabled" />
        <label for="diff-enabled">Include git diff</label>
      </div>
      <select id="diff-scope" class="hidden">
        <option value="working">Working (unstaged)</option>
        <option value="staged">Staged only</option>
        <option value="both">Both</option>
      </select>

      <div class="checkbox-row">
        <input type="checkbox" id="look-for-imports" />
        <label for="look-for-imports">Look for imports (JS/TS)</label>
      </div>
      <div class="checkbox-row">
        <input type="checkbox" id="imports-recursive" checked />
        <label for="imports-recursive">Follow imports recursively</label>
      </div>

      <button class="primary" id="generate">Generate Handoff</button>
      <div id="actions-error" class="error hidden"></div>

      <div class="tier2-toggle" id="tier2-toggle" role="button" aria-expanded="false">
        <span class="codicon" id="tier2-icon"></span>
        <span>Instructions, bookmarks &amp; skipped files</span>
      </div>
      <div class="tier2-body collapsed" id="tier2-body">
        <div id="instructions-wrap" class="hidden">
          <label for="instructions">Custom instructions</label>
          <textarea id="instructions" placeholder="Optional prompt to prepend (e.g. 'Review this for memory leaks')..."></textarea>
        </div>
        <button class="secondary" id="bookmark-save">Save current selection as bookmark</button>

        <div class="subsection">
          <div class="subsection-header" id="bookmarks-header" role="button" aria-expanded="false">
            <span class="codicon" id="bookmarks-icon"></span>
            <span>Bookmarks (<span id="bookmarks-count">0</span>)</span>
          </div>
          <div class="subsection-body collapsed" id="bookmarks-body">
            <div class="subsection-empty" id="bookmarks-empty">No bookmarks saved yet.</div>
            <ul id="bookmark-list"></ul>
          </div>
        </div>

        <div class="subsection">
          <div class="subsection-header" id="skipped-header" role="button" aria-expanded="false">
            <span class="codicon" id="skipped-icon"></span>
            <span>Skipped files (<span id="skip-count">0</span>)</span>
          </div>
          <div class="subsection-body collapsed" id="skipped-body">
            <div class="subsection-empty" id="skip-empty">None — all selected files included.</div>
            <ul id="skip-list"></ul>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${mediaUri('bridge-client.js')}"></script>
  <script nonce="${nonce}" src="${mediaUri('virtual-list.js')}"></script>
  <script nonce="${nonce}" src="${mediaUri('tree-render.js')}"></script>
  <script nonce="${nonce}" src="${mediaUri('search-render.js')}"></script>
  <script nonce="${nonce}" src="${mediaUri('actions-render.js')}"></script>
  <script nonce="${nonce}" src="${mediaUri('main.js')}"></script>
</body>
</html>`;
  }
}
