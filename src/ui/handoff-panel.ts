/**
 * The merged sidebar webview — search input + a custom-rendered (virtualized)
 * file tree + the actions footer, all in one `WebviewViewProvider`, replacing
 * the three separately-chromed views (`aiHandoff.searchBar`,
 * `aiHandoff.fileTree`, `aiHandoff.actionPanel`) that used to live stacked in
 * the sidebar. See CLAUDE.md's architecture notes for why (VS Code enforces
 * a minimum resizable height per stacked view, wasting space the search
 * bar's single input row didn't need).
 *
 * Built up in stages (this is stage 3 of that rollout — see the project's
 * webview-merge plan): only the virtualized, read-only tree render is wired
 * up here, against real `FileTreeModel` data. No checkboxes, no search, no
 * actions footer content yet — those land in later stages, reusing this
 * same shell and render loop. Registered *alongside* the three old views
 * (not replacing them) until the final cutover stage.
 *
 * Framework-free, no build step — same convention as `action-panel.ts`/
 * `search-bar-panel.ts`, just with the webview's JS split into external
 * files under `media/webview/` (loaded via `asWebviewUri()`) instead of one
 * inline template literal, since this view's client-side code (bridge
 * client, virtualization math, tree rendering) is large enough that a
 * single inline string would hurt review/maintenance more than a few extra
 * files does.
 */

import * as path from 'path';
import * as vscode from 'vscode';
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
    /* Placeholder rows — search (stage 5) and actions (stage 6) fill these in later. */
    .search-header-placeholder,
    .actions-footer-placeholder {
      flex: 0 0 auto;
    }
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
    <div class="search-header-placeholder"></div>
    <div id="tree-scroll">
      <div id="tree-spacer"></div>
    </div>
    <div class="actions-footer-placeholder"></div>
  </div>

  <script nonce="${nonce}" src="${mediaUri('bridge-client.js')}"></script>
  <script nonce="${nonce}" src="${mediaUri('virtual-list.js')}"></script>
  <script nonce="${nonce}" src="${mediaUri('tree-render.js')}"></script>
</body>
</html>`;
  }
}
