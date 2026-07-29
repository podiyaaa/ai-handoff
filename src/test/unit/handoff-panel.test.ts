import { expect } from 'chai';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { WebviewView, WorkspaceFolder } from 'vscode';
import { FileTreeModel } from '../../services/file-tree-model';
import { HandoffPanelProvider } from '../../ui/handoff-panel';

function fakeFolder(root: string, index: number): WorkspaceFolder {
  return {
    uri: { fsPath: root } as WorkspaceFolder['uri'],
    name: path.basename(root),
    index,
  };
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# readme');
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const x = 1;');
  return root;
}

function fakeView(): {
  view: WebviewView;
  posted: unknown[];
  trigger: (msg: unknown) => void;
  disposeView: () => void;
} {
  const posted: unknown[] = [];
  let handler: ((msg: unknown) => void) | undefined;
  let disposeHandler: (() => void) | undefined;

  const webview = {
    cspSource: 'vscode-resource:',
    html: '',
    options: undefined as unknown,
    asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => `webview://${uri.fsPath}` }),
    onDidReceiveMessage: (cb: (msg: unknown) => void) => {
      handler = cb;
      return { dispose: () => {} };
    },
    postMessage: (msg: unknown) => {
      posted.push(msg);
      return Promise.resolve(true);
    },
  };

  const view = {
    webview,
    onDidDispose: (cb: () => void) => {
      disposeHandler = cb;
      return { dispose: () => {} };
    },
  } as unknown as WebviewView;

  return {
    view,
    posted,
    trigger: (msg: unknown) => handler?.(msg),
    disposeView: () => disposeHandler?.(),
  };
}

/**
 * `getChildren`/`getVisibleRows` involve real fs I/O (the test harness's
 * `vscode.workspace.fs.readDirectory` stub is backed by real `fs/promises`),
 * which resolves via the event loop's poll phase — a single microtask tick
 * (or even one `setImmediate`) isn't reliably enough time for it to settle.
 * Poll instead of guessing a fixed delay.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil: timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * A `tree/invalidated` event can be pushed (and land in `posted`) between
 * two request/response pairs, since toggling selection also fires
 * FileTreeModel's onDidChangeTree — so responses can't be found by array
 * position, only by their correlation id.
 */
function findResponse(posted: unknown[], id: string): { ok: boolean; result?: unknown } | undefined {
  return posted.find((m) => (m as { kind?: string; id?: string }).kind === 'response' && (m as { id?: string }).id === id) as
    | { ok: boolean; result?: unknown }
    | undefined;
}

describe('HandoffPanelProvider', () => {
  let root: string;
  let model: FileTreeModel;

  beforeEach(async () => {
    root = await makeRoot('aih-handoff-panel-');
    model = new FileTreeModel([fakeFolder(root, 0)]);
  });
  afterEach(async () => {
    model.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('has the expected view type', () => {
    expect(HandoffPanelProvider.viewType).to.equal('aiHandoff.mainView');
  });

  it('enables scripts, scopes localResourceRoots to media/, and references the bridge/render scripts + codicon font', () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model);
    const { view } = fakeView();
    provider.resolveWebviewView(view);

    const options = view.webview.options as { enableScripts?: boolean; localResourceRoots?: unknown[] };
    expect(options.enableScripts).to.be.true;
    // One root covering both media/webview/ (scripts) and media/codicons/ (font).
    expect(options.localResourceRoots).to.have.lengthOf(1);
    expect(view.webview.html).to.include('Content-Security-Policy');
    expect(view.webview.html).to.include('bridge-client.js');
    expect(view.webview.html).to.include('virtual-list.js');
    expect(view.webview.html).to.include('tree-render.js');
    expect(view.webview.html).to.include('search-render.js');
    expect(view.webview.html).to.include('main.js');
    expect(view.webview.html).to.include('codicon.ttf');
    expect(view.webview.html).to.include('id="tree-scroll"');
    expect(view.webview.html).to.include('id="query"');
  });

  it('tree/setSearchQuery parses the query and applies it to the model', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model);
    const { view, posted, trigger } = fakeView();
    provider.resolveWebviewView(view);

    trigger({ kind: 'request', id: '1', method: 'tree/setSearchQuery', params: { text: 'index' } });
    await waitUntil(() => Boolean(findResponse(posted, '1')));

    const response = findResponse(posted, '1') as { result: { error: string | undefined } };
    expect(response.result.error).to.be.undefined;

    const children = await model.getChildren(undefined);
    expect(children.map((c) => c.relativePath)).to.deep.equal(['src']); // README.md doesn't match "index"
  });

  it('tree/setSearchQuery surfaces a parse error without changing the model\'s query', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model);
    const { view, posted, trigger } = fakeView();
    provider.resolveWebviewView(view);

    trigger({ kind: 'request', id: '1', method: 'tree/setSearchQuery', params: { text: 're:(' } });
    await waitUntil(() => Boolean(findResponse(posted, '1')));

    const response = findResponse(posted, '1') as { result: { error: string | undefined } };
    expect(response.result.error).to.be.a('string');
    expect(model.getSearchQuery()).to.be.undefined;
  });

  it('tree/getChildren delegates to the model', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model);
    const { view, posted, trigger } = fakeView();
    provider.resolveWebviewView(view);

    trigger({ kind: 'request', id: '1', method: 'tree/getChildren', params: { path: undefined } });
    await waitUntil(() => posted.length >= 1);

    expect(posted).to.have.lengthOf(1);
    const response = posted[0] as { ok: boolean; result: Array<{ name: string }> };
    expect(response.ok).to.be.true;
    expect(response.result.map((r) => r.name)).to.deep.equal(['src', 'README.md']);
  });

  it('tree/toggleExpand + tree/getVisibleRows round-trip reflects expand state', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model);
    const { view, posted, trigger } = fakeView();
    provider.resolveWebviewView(view);

    trigger({ kind: 'request', id: '1', method: 'tree/toggleExpand', params: { path: 'src', expanded: true } });
    await waitUntil(() => posted.length >= 1);
    trigger({ kind: 'request', id: '2', method: 'tree/getVisibleRows', params: undefined });
    await waitUntil(() => posted.length >= 2);

    const rowsResponse = posted[1] as { result: Array<{ relativePath: string }> };
    expect(rowsResponse.result.map((r) => r.relativePath)).to.include('src/index.ts');
  });

  it('tree/toggleFile delegates to the model and is reflected in the next getChildren call', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model);
    const { view, posted, trigger } = fakeView();
    provider.resolveWebviewView(view);

    trigger({
      kind: 'request',
      id: '1',
      method: 'tree/toggleFile',
      params: { path: 'README.md', checked: true },
    });
    await waitUntil(() => posted.length >= 1);
    expect(model.getSelection()).to.deep.equal(['README.md']);

    trigger({ kind: 'request', id: '2', method: 'tree/getChildren', params: { path: undefined } });
    await waitUntil(() => Boolean(findResponse(posted, '2')));
    const response = findResponse(posted, '2') as { result: Array<{ name: string; checkboxState: string }> };
    const readme = response.result.find((r) => r.name === 'README.md')!;
    expect(readme.checkboxState).to.equal('checked');
  });

  it('tree/toggleDirectory delegates to the model and selects every descendant file', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model);
    const { view, posted, trigger } = fakeView();
    provider.resolveWebviewView(view);

    trigger({
      kind: 'request',
      id: '1',
      method: 'tree/toggleDirectory',
      params: { path: 'src', checked: true },
    });
    await waitUntil(() => posted.length >= 1);
    expect(model.getSelection()).to.deep.equal(['src/index.ts']);
  });

  it('pushes a tree/invalidated event when the model changes', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model);
    const { view, posted } = fakeView();
    provider.resolveWebviewView(view);

    await model.toggleFile('README.md', true);

    const invalidated = posted.find(
      (m) => (m as { kind: string; event?: string }).kind === 'event' && (m as { event?: string }).event === 'tree/invalidated',
    );
    expect(invalidated).to.deep.equal({ kind: 'event', event: 'tree/invalidated', payload: { path: undefined } });
  });

  // Not covered here: that disposing the view actually stops further events.
  // The shared vscode stub's EventEmitter.event() returns a disposable whose
  // dispose() is a no-op (doesn't remove the listener), unlike the real VS
  // Code API — so this harness can't distinguish "really disposed" from
  // "handlers cleared" for a model-owned EventEmitter the way
  // webview-host-bridge.test.ts could for its own fake webview's
  // onDidReceiveMessage. Verified instead by code review: resolveWebviewView
  // wires exactly one onDidDispose that disposes both the change listener
  // and the bridge.
});
