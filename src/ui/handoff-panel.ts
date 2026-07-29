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
 * tree render, checkbox selection, and search are wired up so far, against
 * real `FileTreeModel` data. The actions footer content still doesn't exist
 * yet (empty placeholder) — that's the next stage, reusing this same shell.
 * Registered *alongside* the three old views (not replacing them) until the
 * final cutover stage.
 *
 * Framework-free, no build step — same convention as `action-panel.ts`/
 * `search-bar-panel.ts`, just with the webview's JS split into external
 * files under `media/webview/` (loaded via `asWebviewUri()`) instead of one
 * inline template literal, since this view's client-side code (bridge
 * client, virtualization math, tree/search rendering) is large enough that
 * a single inline string would hurt review/maintenance more than a few
 * extra files does.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { parseSearchQuery } from '../core/search-filter';
import type { FileTreeModel } from '../services/file-tree-model';
import { HostBridge } from './webview-host-bridge';
import { generateNonce } from './webview-nonce';

export class HandoffPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aiHandoff.mainView';

  private bridge: HostBridge | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly model: FileTreeModel,
  ) {}

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

    view.onDidDispose(() => {
      changeListener.dispose();
      bridge.dispose();
      if (this.bridge === bridge) {
        this.bridge = undefined;
      }
    });
  }

  private registerHandlers(bridge: HostBridge): void {
    bridge.handle('tree/getChildren', ({ path }) => this.model.getChildren(path));
    bridge.handle('tree/getVisibleRows', () => this.model.getVisibleRows());
    bridge.handle('tree/toggleExpand', ({ path, expanded }) => {
      this.model.setExpanded(path, expanded);
    });
    bridge.handle('tree/toggleFile', ({ path, checked }) => this.model.toggleFile(path, checked));
    bridge.handle('tree/toggleDirectory', ({ path, checked }) => this.model.toggleDirectory(path, checked));
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
  }

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
    /* Actions footer placeholder — stage 6 fills this in. */
    .actions-footer-placeholder {
      flex: 0 0 auto;
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
      <div id="tree-spacer"></div>
    </div>
    <div class="actions-footer-placeholder"></div>
  </div>

  <script nonce="${nonce}" src="${mediaUri('bridge-client.js')}"></script>
  <script nonce="${nonce}" src="${mediaUri('virtual-list.js')}"></script>
  <script nonce="${nonce}" src="${mediaUri('tree-render.js')}"></script>
  <script nonce="${nonce}" src="${mediaUri('search-render.js')}"></script>
  <script nonce="${nonce}" src="${mediaUri('main.js')}"></script>
</body>
</html>`;
  }
}
