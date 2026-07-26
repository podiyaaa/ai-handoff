import { expect } from 'chai';
import type { WebviewView } from 'vscode';
import { SearchBarProvider, type FromSearchBarMessage } from '../../ui/search-bar-panel';

function fakeWebviewView(): {
  view: WebviewView;
  posted: unknown[];
  trigger: (msg: FromSearchBarMessage) => void;
} {
  const posted: unknown[] = [];
  let handler: ((msg: FromSearchBarMessage) => void) | undefined;

  const webview = {
    cspSource: 'vscode-resource:',
    html: '',
    options: undefined,
    onDidReceiveMessage: (cb: (msg: FromSearchBarMessage) => void) => {
      handler = cb;
      return { dispose: () => {} };
    },
    postMessage: (msg: unknown) => {
      posted.push(msg);
      return Promise.resolve(true);
    },
  };

  const view = { webview } as unknown as WebviewView;
  return {
    view,
    posted,
    trigger: (msg: FromSearchBarMessage) => handler?.(msg),
  };
}

describe('SearchBarProvider', () => {
  it('has the expected view type', () => {
    expect(SearchBarProvider.viewType).to.equal('aiHandoff.searchBar');
  });

  it('renders a webview with the search input and enables scripts', () => {
    const provider = new SearchBarProvider({ fsPath: '/fake' } as never);
    const { view } = fakeWebviewView();
    provider.resolveWebviewView(view);

    expect((view.webview.options as { enableScripts?: boolean }).enableScripts).to.be.true;
    expect(view.webview.html).to.include('id="query"');
    expect(view.webview.html).to.include('acquireVsCodeApi');
    expect(view.webview.html).to.include('Content-Security-Policy');
  });

  it('forwards messages from the webview via onDidReceive', () => {
    const provider = new SearchBarProvider({ fsPath: '/fake' } as never);
    const { view, trigger } = fakeWebviewView();
    provider.resolveWebviewView(view);

    const received: FromSearchBarMessage[] = [];
    provider.onDidReceive((msg) => received.push(msg));

    trigger({ type: 'queryChange', text: 'ext:ts' });
    expect(received).to.deep.equal([{ type: 'queryChange', text: 'ext:ts' }]);
  });

  it('setError posts an error message to the webview', () => {
    const provider = new SearchBarProvider({ fsPath: '/fake' } as never);
    const { view, posted } = fakeWebviewView();
    provider.resolveWebviewView(view);

    provider.setError('Invalid regex: bad');
    provider.setError(undefined);

    expect(posted).to.deep.equal([
      { type: 'error', message: 'Invalid regex: bad' },
      { type: 'error', message: undefined },
    ]);
  });

  it('setError before resolveWebviewView is a no-op (no pending webview yet)', () => {
    const provider = new SearchBarProvider({ fsPath: '/fake' } as never);
    expect(() => provider.setError('too early')).to.not.throw();
  });
});
