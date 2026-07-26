/**
 * Action panel — a small webview in the sidebar that shows:
 *
 *   - Stats: # files, KB, estimated tokens
 *   - Output format dropdown (xml/markdown/plain)
 *   - Optional custom instructions text area (controlled by setting)
 *   - "Generate Handoff" button
 *   - Skipped files summary with [override] links
 *
 * Communicates with the extension host via postMessage. The webview
 * is intentionally simple — no frameworks, no build step, just inline
 * HTML + CSS + JS that uses VS Code's CSS variables for theming.
 */

import * as vscode from 'vscode';
import type { OutputFormat } from '../core/types';
import { formatBytes } from '../core/filter';
import { formatTokenCount } from '../core/token-estimator';

/**
 * Stats passed from extension host to the webview.
 */
export interface PanelStats {
  fileCount: number;
  totalSizeBytes: number;
  estimatedTokens: number;
}

/**
 * A skipped file shown in the panel's skipped list.
 */
export interface PanelSkippedFile {
  relativePath: string;
  reason: string;
  detail?: string;
}

/**
 * Messages from webview to extension host.
 */
export type FromWebviewMessage =
  | { type: 'ready' }
  | { type: 'generate' }
  | { type: 'formatChange'; format: OutputFormat }
  | { type: 'instructionsChange'; text: string }
  | { type: 'overrideFile'; path: string }
  | { type: 'showAll' } // expand skipped list
  | { type: 'saveBookmark' }
  | { type: 'loadBookmark'; name: string }
  | { type: 'overrideBookmark'; name: string }
  | { type: 'deleteBookmark'; name: string };

/**
 * A bookmark shown in the panel's bookmarks list.
 */
export interface PanelBookmark {
  name: string;
  fileCount: number;
}

/**
 * Messages from extension host to webview.
 */
export type ToWebviewMessage =
  | {
      type: 'state';
      stats: PanelStats;
      format: OutputFormat;
      showCustomInstructions: boolean;
      instructions: string;
      skipped: PanelSkippedFile[];
    }
  | { type: 'generating'; busy: boolean }
  | { type: 'error'; message: string }
  | { type: 'bookmarks'; items: PanelBookmark[] };

/**
 * The provider. Registered against the "aiHandoff.actionPanel" view ID.
 */
export class ActionPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aiHandoff.actionPanel';

  private view: vscode.WebviewView | undefined;
  private currentState: Omit<Extract<ToWebviewMessage, { type: 'state' }>, 'type'> = {
    stats: { fileCount: 0, totalSizeBytes: 0, estimatedTokens: 0 },
    format: 'xml',
    showCustomInstructions: false,
    instructions: '',
    skipped: [],
  };

  private readonly _onDidReceive = new vscode.EventEmitter<FromWebviewMessage>();
  /** Subscribe to messages from the webview. */
  readonly onDidReceive = this._onDidReceive.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: FromWebviewMessage) => {
      this._onDidReceive.fire(msg);
    });
    // Send initial state once the webview signals ready.
  }

  /**
   * Update the displayed state. Safe to call before resolveWebviewView —
   * we cache and push on resolve.
   */
  updateState(state: Partial<Omit<Extract<ToWebviewMessage, { type: 'state' }>, 'type'>>): void {
    this.currentState = { ...this.currentState, ...state };
    this.post({ type: 'state', ...this.currentState });
  }

  /** Show a busy spinner on the Generate button while generation is running. */
  setBusy(busy: boolean): void {
    this.post({ type: 'generating', busy });
  }

  /** Show a transient error in the panel. */
  showError(message: string): void {
    this.post({ type: 'error', message });
  }

  /** Push the current bookmark list to the webview. */
  postBookmarks(sets: Record<string, string[]>): void {
    const items: PanelBookmark[] = Object.entries(sets).map(([name, paths]) => ({
      name,
      fileCount: paths.length,
    }));
    this.post({ type: 'bookmarks', items });
  }

  private post(message: ToWebviewMessage): void {
    this.view?.webview.postMessage(message);
  }

  /**
   * The static HTML. Uses VS Code's CSS variables for theming so the panel
   * adapts to light/dark/high-contrast themes automatically.
   */
  private renderHtml(webview: vscode.Webview): string {
    const nonce = generateNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
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
    body {
      padding: 10px 12px;
      margin: 0;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background: transparent;
    }

    .stats {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 4px 12px;
      margin-bottom: 12px;
      padding: 8px 10px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
    }
    .stats .label { opacity: 0.7; }
    .stats .value { font-variant-numeric: tabular-nums; font-weight: 500; }

    label {
      display: block;
      margin: 10px 0 4px;
      opacity: 0.85;
    }

    select,
    textarea {
      width: 100%;
      padding: 4px 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    select:focus,
    textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    textarea {
      min-height: 80px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family, monospace);
    }

    button.primary {
      width: 100%;
      margin-top: 12px;
      padding: 6px 10px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      cursor: pointer;
    }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.primary:disabled { opacity: 0.5; cursor: default; }

    button.secondary {
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
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-editor-inactiveSelectionBackground)); }

    .bookmarks {
      margin-top: 14px;
      padding-top: 10px;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    }
    .bookmarks h4 {
      margin: 0 0 6px;
      font-size: var(--vscode-font-size);
      font-weight: 600;
      opacity: 0.8;
    }
    .bookmarks ul { list-style: none; padding: 0; margin: 0; }
    .bookmarks li {
      padding: 2px 0;
      display: flex;
      gap: 6px;
      align-items: baseline;
      font-size: 0.9em;
    }
    .bk-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bk-count { opacity: 0.55; font-size: 0.85em; flex-shrink: 0; }
    a.bk-action {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      cursor: pointer;
      flex-shrink: 0;
    }
    a.bk-action:hover { text-decoration: underline; }

    .skipped {
      margin-top: 14px;
      padding-top: 10px;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    }
    .skipped h4 {
      margin: 0 0 6px;
      font-size: var(--vscode-font-size);
      font-weight: 600;
      opacity: 0.8;
    }
    .skipped-empty { opacity: 0.6; font-style: italic; }
    .skipped ul { list-style: none; padding: 0; margin: 0; }
    .skipped li {
      padding: 2px 0;
      display: flex;
      gap: 6px;
      align-items: baseline;
      font-size: 0.9em;
    }
    .skipped li .path {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0.85;
    }
    .skipped li .detail { opacity: 0.55; font-size: 0.85em; }
    .skipped a.override {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      cursor: pointer;
      flex-shrink: 0;
    }
    .skipped a.override:hover { text-decoration: underline; }

    .error {
      margin-top: 10px;
      padding: 6px 10px;
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 2px;
      font-size: 0.9em;
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="stats" aria-label="Selection statistics">
    <span class="label">Files:</span>
    <span class="value" id="stat-files">0</span>
    <span class="label">Size:</span>
    <span class="value" id="stat-size">0 B</span>
    <span class="label">Tokens:</span>
    <span class="value" id="stat-tokens">~0</span>
  </div>

  <label for="format">Output format</label>
  <select id="format">
    <option value="xml">XML (best for AI)</option>
    <option value="markdown">Markdown</option>
    <option value="plain">Plain text</option>
  </select>

  <div id="instructions-wrap" class="hidden">
    <label for="instructions">Custom instructions</label>
    <textarea id="instructions" placeholder="Optional prompt to prepend (e.g. 'Review this for memory leaks')..."></textarea>
  </div>

  <button class="primary" id="generate">Generate Handoff</button>
  <button class="secondary" id="bookmark-save">Save as Bookmark</button>

  <div id="error" class="error hidden"></div>

  <div class="bookmarks">
    <h4>Bookmarks</h4>
    <div class="skipped-empty" id="bookmarks-empty">No bookmarks saved yet.</div>
    <ul id="bookmark-list"></ul>
  </div>

  <div class="skipped">
    <h4>Skipped files (<span id="skip-count">0</span>)</h4>
    <div class="skipped-empty" id="skip-empty">None — all selected files included.</div>
    <ul id="skip-list"></ul>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $files = document.getElementById('stat-files');
    const $size = document.getElementById('stat-size');
    const $tokens = document.getElementById('stat-tokens');
    const $format = document.getElementById('format');
    const $insWrap = document.getElementById('instructions-wrap');
    const $ins = document.getElementById('instructions');
    const $btn = document.getElementById('generate');
    const $bookmarkSave = document.getElementById('bookmark-save');
    const $bookmarksEmpty = document.getElementById('bookmarks-empty');
    const $bookmarkList = document.getElementById('bookmark-list');
    const $err = document.getElementById('error');
    const $skipCount = document.getElementById('skip-count');
    const $skipEmpty = document.getElementById('skip-empty');
    const $skipList = document.getElementById('skip-list');

    let debounce;

    $format.addEventListener('change', () => {
      vscode.postMessage({ type: 'formatChange', format: $format.value });
    });
    $ins.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        vscode.postMessage({ type: 'instructionsChange', text: $ins.value });
      }, 200);
    });
    $btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'generate' });
    });
    $bookmarkSave.addEventListener('click', () => {
      vscode.postMessage({ type: 'saveBookmark' });
    });

    function renderBookmarks(items) {
      $bookmarkList.innerHTML = '';
      if (items.length === 0) {
        $bookmarksEmpty.classList.remove('hidden');
        return;
      }
      $bookmarksEmpty.classList.add('hidden');
      for (const item of items) {
        const li = document.createElement('li');

        const name = document.createElement('span');
        name.className = 'bk-name';
        name.textContent = item.name;
        name.title = item.name;

        const count = document.createElement('span');
        count.className = 'bk-count';
        count.textContent = '(' + item.fileCount + ')';

        const load = document.createElement('a');
        load.className = 'bk-action';
        load.textContent = '[load]';
        load.addEventListener('click', (e) => {
          e.preventDefault();
          vscode.postMessage({ type: 'loadBookmark', name: item.name });
        });

        const override = document.createElement('a');
        override.className = 'bk-action';
        override.textContent = '[override]';
        override.addEventListener('click', (e) => {
          e.preventDefault();
          vscode.postMessage({ type: 'overrideBookmark', name: item.name });
        });

        const del = document.createElement('a');
        del.className = 'bk-action';
        del.textContent = '[delete]';
        del.addEventListener('click', (e) => {
          e.preventDefault();
          vscode.postMessage({ type: 'deleteBookmark', name: item.name });
        });

        li.append(name, count, load, override, del);
        $bookmarkList.appendChild(li);
      }
    }

    function renderSkipped(items) {
      $skipCount.textContent = items.length;
      $skipList.innerHTML = '';
      if (items.length === 0) {
        $skipEmpty.classList.remove('hidden');
        return;
      }
      $skipEmpty.classList.add('hidden');
      for (const item of items) {
        const li = document.createElement('li');
        const path = document.createElement('span');
        path.className = 'path';
        path.textContent = item.relativePath;
        path.title = (item.detail ? item.reason + ' — ' + item.detail : item.reason);
        const detail = document.createElement('span');
        detail.className = 'detail';
        detail.textContent = item.detail || item.reason;
        const override = document.createElement('a');
        override.className = 'override';
        override.textContent = '[include anyway]';
        override.addEventListener('click', (e) => {
          e.preventDefault();
          vscode.postMessage({ type: 'overrideFile', path: item.relativePath });
        });
        li.appendChild(path);
        li.appendChild(detail);
        li.appendChild(override);
        $skipList.appendChild(li);
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'state':
          $files.textContent = msg.stats.fileCount;
          $size.textContent = msg.stats.sizeFormatted;
          $tokens.textContent = '~' + msg.stats.tokensFormatted;
          $format.value = msg.format;
          if (msg.showCustomInstructions) {
            $insWrap.classList.remove('hidden');
            if ($ins.value !== msg.instructions) {
              $ins.value = msg.instructions || '';
            }
          } else {
            $insWrap.classList.add('hidden');
          }
          renderSkipped(msg.skipped);
          $err.classList.add('hidden');
          break;
        case 'bookmarks':
          renderBookmarks(msg.items);
          break;
        case 'generating':
          $btn.disabled = msg.busy;
          $btn.textContent = msg.busy ? 'Generating…' : 'Generate Handoff';
          break;
        case 'error':
          $err.textContent = msg.message;
          $err.classList.remove('hidden');
          break;
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

/**
 * Pre-format stats for the webview (so the webview is a dumb renderer).
 */
export function formatStatsForPanel(stats: PanelStats): PanelStats & {
  sizeFormatted: string;
  tokensFormatted: string;
} {
  return {
    ...stats,
    sizeFormatted: formatBytes(stats.totalSizeBytes),
    tokensFormatted: formatTokenCount(stats.estimatedTokens),
  };
}

/**
 * Random nonce for the webview's CSP. Shared with other webview providers
 * (e.g. SearchBarProvider) so there's one implementation.
 */
export function generateNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}
