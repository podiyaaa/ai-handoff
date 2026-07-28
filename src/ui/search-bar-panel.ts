/**
 * Search bar panel — a small webview pinned directly above the Files tree
 * in the sidebar.
 *
 * VS Code's TreeView API has no way to embed a persistent, type-as-you-go
 * input inside or above a native tree — the title bar only supports icon
 * buttons, and `TreeView.message` is read-only text. A dedicated webview
 * view is the only way to get an always-visible, live search box, so this
 * mirrors ActionPanelProvider's approach: no framework, inline HTML/CSS/JS,
 * VS Code CSS variables for theming.
 *
 * The webview owns the input's value and debounces keystrokes itself
 * before posting `queryChange`; the extension host is the source of truth
 * for validity and only pushes back an `error` message when the current
 * text fails to parse (e.g. an unterminated regex).
 */

import * as vscode from 'vscode';
import { generateNonce } from './webview-nonce';

export type FromSearchBarMessage = { type: 'ready' } | { type: 'queryChange'; text: string };

export type ToSearchBarMessage = { type: 'error'; message: string | undefined };

export class SearchBarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aiHandoff.searchBar';

  private view: vscode.WebviewView | undefined;

  private readonly _onDidReceive = new vscode.EventEmitter<FromSearchBarMessage>();
  readonly onDidReceive = this._onDidReceive.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: FromSearchBarMessage) => {
      this._onDidReceive.fire(msg);
    });
  }

  /** Show (or clear, with `undefined`) an inline validation error under the input. */
  setError(message: string | undefined): void {
    this.post({ type: 'error', message });
  }

  private post(message: ToSearchBarMessage): void {
    this.view?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = generateNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Search</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      height: 100%;
    }
    body {
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 6px 12px;
      margin: 0;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      /* Match the Files tree right below us so the two panes read as one
         surface rather than two visibly different boxes. */
      background: var(--vscode-sideBar-background, transparent);
    }
    .search-wrap {
      position: relative;
      display: flex;
      align-items: center;
    }
    input {
      width: 100%;
      padding: 4px 24px 4px 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    input.invalid {
      border-color: var(--vscode-inputValidation-errorBorder);
    }
    button.clear {
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
    button.clear:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2));
    }
    .hint, .error {
      margin-top: 4px;
      font-size: 0.85em;
    }
    /* Resting state is just the input — one compact row. The hint only
       appears while actively using the box (focused or has text), so the
       pane doesn't default to looking like an oversized empty box. */
    .hint { opacity: 0.6; }
    .error { color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground)); }
    .hidden { display: none !important; }
  </style>
</head>
<body>
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

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $input = document.getElementById('query');
    const $clear = document.getElementById('clear');
    const $hint = document.getElementById('hint');
    const $error = document.getElementById('error');

    let debounceHandle;
    let hasError = false;

    function send() {
      vscode.postMessage({ type: 'queryChange', text: $input.value });
    }

    function scheduleSend() {
      clearTimeout(debounceHandle);
      debounceHandle = setTimeout(send, 250);
    }

    function clear() {
      $input.value = '';
      $clear.classList.add('hidden');
      clearTimeout(debounceHandle);
      send();
    }

    // Resting state shows just the input. The hint only shows up while
    // actively using the box, so the pane doesn't read as an oversized
    // empty box when idle.
    function updateHintVisibility() {
      const active = document.activeElement === $input || $input.value.length > 0;
      $hint.classList.toggle('hidden', hasError || !active);
    }

    $input.addEventListener('input', () => {
      $clear.classList.toggle('hidden', $input.value.length === 0);
      updateHintVisibility();
      scheduleSend();
    });

    $input.addEventListener('focus', updateHintVisibility);
    $input.addEventListener('blur', updateHintVisibility);

    $input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $input.value.length > 0) {
        e.stopPropagation();
        clear();
      }
    });

    $clear.addEventListener('click', () => {
      clear();
      $input.focus();
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'error') {
        hasError = Boolean(msg.message);
        $input.classList.toggle('invalid', hasError);
        $error.textContent = msg.message || '';
        $error.classList.toggle('hidden', !hasError);
        updateHintVisibility();
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
