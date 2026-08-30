import { expect } from 'chai';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { WebviewView, WorkspaceFolder } from 'vscode';
import { FileTreeModel } from '../../services/file-tree-model';
import * as handoffGeneratorModule from '../../services/handoff-generator';
import { InMemoryMemento, SelectionStore } from '../../services/selection-store';
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
  let store: SelectionStore;

  beforeEach(async () => {
    root = await makeRoot('aih-handoff-panel-');
    model = new FileTreeModel([fakeFolder(root, 0)]);
    store = new SelectionStore(new InMemoryMemento());
  });
  afterEach(async () => {
    model.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('has the expected view type', () => {
    expect(HandoffPanelProvider.viewType).to.equal('aiHandoff.mainView');
  });

  it('enables scripts, scopes localResourceRoots to media/, and references the bridge/render scripts + codicon font', () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
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
    expect(view.webview.html).to.include('id="no-workspace"');
    expect(view.webview.html).to.include('role="tree"');
  });

  it('tree/setSearchQuery parses the query and applies it to the model', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
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
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
    const { view, posted, trigger } = fakeView();
    provider.resolveWebviewView(view);

    trigger({ kind: 'request', id: '1', method: 'tree/setSearchQuery', params: { text: 're:(' } });
    await waitUntil(() => Boolean(findResponse(posted, '1')));

    const response = findResponse(posted, '1') as { result: { error: string | undefined } };
    expect(response.result.error).to.be.a('string');
    expect(model.getSearchQuery()).to.be.undefined;
  });

  it('tree/getChildren delegates to the model', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
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
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
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
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
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
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
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

  it('file/open resolves the relative path and opens it via vscode.open', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
    const { view, posted, trigger } = fakeView();
    provider.resolveWebviewView(view);

    const executed = (global as unknown as { __testExecutedCommands: Array<{ command: string; args: unknown[] }> })
      .__testExecutedCommands;
    const before = executed.length;

    trigger({ kind: 'request', id: '1', method: 'file/open', params: { path: 'README.md' } });
    await waitUntil(() => posted.length >= 1);

    expect(executed.length).to.equal(before + 1);
    const call = executed[executed.length - 1];
    expect(call.command).to.equal('vscode.open');
    expect((call.args[0] as { fsPath: string }).fsPath).to.equal(path.join(root, 'README.md'));
  });

  it('file/open is a no-op for a path that cannot be resolved (no workspace folder owns it)', async () => {
    // resolveAbsolutePath only fails to resolve on an unrecognized folder-name
    // prefix in multi-root mode — a single-root model resolves any relative
    // path against its one folder unconditionally, so this needs its own
    // multi-root model to exercise the failure path at all.
    const rootB = await makeRoot('aih-handoff-panel-b-');
    const multiRootModel = new FileTreeModel([fakeFolder(root, 0), fakeFolder(rootB, 1)]);
    try {
      const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, multiRootModel, store, root);
      const { view, posted, trigger } = fakeView();
      provider.resolveWebviewView(view);

      const executed = (
        global as unknown as { __testExecutedCommands: Array<{ command: string; args: unknown[] }> }
      ).__testExecutedCommands;
      const before = executed.length;

      trigger({ kind: 'request', id: '1', method: 'file/open', params: { path: 'not-a-real-folder/x.ts' } });
      await waitUntil(() => Boolean(findResponse(posted, '1')));

      expect(executed.length).to.equal(before);
      expect((findResponse(posted, '1') as { ok: boolean }).ok).to.be.true;
    } finally {
      multiRootModel.dispose();
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it('actions/ready returns the full current state and bookmarks directly (not via the push events)', async () => {
    await model.toggleFile('README.md', true);
    await store.saveNamedSet('Existing', ['README.md']);
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
    const { view, posted, trigger } = fakeView();
    provider.resolveWebviewView(view);

    trigger({ kind: 'request', id: '1', method: 'actions/ready', params: undefined });
    await waitUntil(() => Boolean(findResponse(posted, '1')));

    const response = findResponse(posted, '1') as {
      result: { state: { stats: { fileCount: number }; format: string; hasWorkspace: boolean }; bookmarks: Array<{ name: string }> };
    };
    expect(response.result.state.stats.fileCount).to.equal(1);
    expect(response.result.state.format).to.equal('xml');
    expect(response.result.state.hasWorkspace).to.be.true;
    expect(response.result.bookmarks.map((b) => b.name)).to.deep.equal(['Existing']);
  });

  it('actions/ready reports hasWorkspace: false when no workspace folder is open, so the tree can show an empty state', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, undefined);
    const { view, posted, trigger } = fakeView();
    provider.resolveWebviewView(view);

    trigger({ kind: 'request', id: '1', method: 'actions/ready', params: undefined });
    await waitUntil(() => Boolean(findResponse(posted, '1')));

    const response = findResponse(posted, '1') as { result: { state: { hasWorkspace: boolean } } };
    expect(response.result.state.hasWorkspace).to.be.false;
  });

  it('actions/setFormat updates the format and is reflected in the next actions/ready call', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
    const { view, posted, trigger } = fakeView();
    provider.resolveWebviewView(view);

    trigger({ kind: 'request', id: '1', method: 'actions/setFormat', params: { format: 'markdown' } });
    await waitUntil(() => Boolean(findResponse(posted, '1')));

    trigger({ kind: 'request', id: '2', method: 'actions/ready', params: undefined });
    await waitUntil(() => Boolean(findResponse(posted, '2')));
    const response = findResponse(posted, '2') as { result: { state: { format: string } } };
    expect(response.result.state.format).to.equal('markdown');
  });

  it('actions/setDiffEnabled and actions/setDiffScope update state together', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
    const { view, posted, trigger } = fakeView();
    provider.resolveWebviewView(view);

    trigger({ kind: 'request', id: '1', method: 'actions/setDiffEnabled', params: { enabled: true } });
    await waitUntil(() => Boolean(findResponse(posted, '1')));
    trigger({ kind: 'request', id: '2', method: 'actions/setDiffScope', params: { scope: 'staged' } });
    await waitUntil(() => Boolean(findResponse(posted, '2')));

    trigger({ kind: 'request', id: '3', method: 'actions/ready', params: undefined });
    await waitUntil(() => Boolean(findResponse(posted, '3')));
    const response = findResponse(posted, '3') as { result: { state: { gitDiffEnabled: boolean; diffScope: string } } };
    expect(response.result.state.gitDiffEnabled).to.be.true;
    expect(response.result.state.diffScope).to.equal('staged');
  });

  it('actions/overrideFile adds the path to both overriddenPaths and the current selection', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
    const { view, posted, trigger } = fakeView();
    provider.resolveWebviewView(view);

    trigger({ kind: 'request', id: '1', method: 'actions/overrideFile', params: { path: 'README.md' } });
    await waitUntil(() => Boolean(findResponse(posted, '1')));

    expect(model.getSelection()).to.deep.equal(['README.md']);
  });

  it('discards a stale, slower pushState() result instead of overwriting a newer, faster one', async () => {
    // Regression test for a real repro: toggling several files in quick
    // succession fires onDidChangeSelection once per toggle, each of which
    // kicks off its own async computeState() (real fs I/O via
    // generateHandoff). Nothing guaranteed those resolve in call order, so
    // an earlier, slower computation landing after a later, faster one
    // could overwrite the newer (correct) stats with stale ones — the
    // selection itself was right, but the fileCount/size/tokens panel
    // lagged behind. Simulate that exact ordering deterministically by
    // making the 1-file computation slow and the 2-file one fast.
    const original = handoffGeneratorModule.generateHandoff;
    (handoffGeneratorModule as unknown as { generateHandoff: typeof original }).generateHandoff = (async (
      ...args: Parameters<typeof original>
    ) => {
      const selected = args[0];
      if (selected.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return original(...args);
    }) as typeof original;

    try {
      const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
      const { view, posted } = fakeView();
      provider.resolveWebviewView(view);

      await model.toggleFile('README.md', true); // slow: 1 file, pushState #1
      await model.toggleFile('src/index.ts', true); // fast: 2 files, pushState #2

      await new Promise((resolve) => setTimeout(resolve, 80)); // let the slow one resolve too

      const stateEvents = posted.filter(
        (m) => (m as { kind?: string; event?: string }).kind === 'event' && (m as { event?: string }).event === 'state',
      ) as Array<{ payload: { stats: { fileCount: number } } }>;
      expect(stateEvents).to.have.lengthOf(1);
      expect(stateEvents[0].payload.stats.fileCount).to.equal(2);
    } finally {
      (handoffGeneratorModule as unknown as { generateHandoff: typeof original }).generateHandoff = original;
    }
  });

  describe('actions/generate — error paths only', () => {
    // The successful generate+dispatch+clipboard round trip is intentionally
    // not exercised here — it would need the pickDestinations()/
    // dispatchHandoff() QuickPick-item shape and vscode.env.clipboard wired
    // into the shared stub for a fairly marginal return, given
    // generateHandoff() and output-picker.ts's pure logic already have their
    // own direct test coverage elsewhere. These two error paths don't need
    // any of that machinery.

    it('emits an error and does not throw when no workspace folder is open', async () => {
      const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, undefined);
      const { view, posted, trigger } = fakeView();
      provider.resolveWebviewView(view);

      trigger({ kind: 'request', id: '1', method: 'actions/generate', params: undefined });
      await waitUntil(() => Boolean(findResponse(posted, '1')));

      const errorEvent = posted.find(
        (m) => (m as { kind?: string; event?: string }).kind === 'event' && (m as { event?: string }).event === 'error',
      ) as { payload: { message: string } } | undefined;
      expect(errorEvent?.payload.message).to.equal('No workspace folder is open.');
    });

    it('emits an error when nothing is selected', async () => {
      const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
      const { view, posted, trigger } = fakeView();
      provider.resolveWebviewView(view);

      trigger({ kind: 'request', id: '1', method: 'actions/generate', params: undefined });
      await waitUntil(() => Boolean(findResponse(posted, '1')));

      const errorEvent = posted.find(
        (m) => (m as { kind?: string; event?: string }).kind === 'event' && (m as { event?: string }).event === 'error',
      ) as { payload: { message: string } } | undefined;
      expect(errorEvent?.payload.message).to.equal('Select at least one file before generating.');
    });
  });

  describe('bookmarks', () => {
    afterEach(() => {
      const responses = (global as unknown as { __testWindowResponses: Record<string, unknown> })
        .__testWindowResponses;
      responses.showInputBox = undefined;
      responses.showWarningMessage = undefined;
      const messages = (global as unknown as { __testWindowMessages: { warning: unknown[]; information: unknown[] } })
        .__testWindowMessages;
      messages.warning.length = 0;
      messages.information.length = 0;
    });

    it('bookmarks/save prompts for a name and saves the current selection', async () => {
      (global as unknown as { __testWindowResponses: { showInputBox: string } }).__testWindowResponses.showInputBox =
        'Auth module';
      const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
      const { view, posted, trigger } = fakeView();
      provider.resolveWebviewView(view);
      await model.toggleFile('README.md', true);

      trigger({ kind: 'request', id: '1', method: 'bookmarks/save', params: undefined });
      await waitUntil(() => Boolean(findResponse(posted, '1')));

      expect(store.getNamedSet('Auth module')).to.deep.equal(['README.md']);
      const bookmarksEvent = posted.find(
        (m) => (m as { kind?: string; event?: string }).kind === 'event' && (m as { event?: string }).event === 'bookmarks',
      ) as { payload: Array<{ name: string }> } | undefined;
      expect(bookmarksEvent?.payload.map((b) => b.name)).to.deep.equal(['Auth module']);
    });

    it('bookmarks/save warns and does not save when nothing is selected', async () => {
      const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
      const { view, posted, trigger } = fakeView();
      provider.resolveWebviewView(view);

      trigger({ kind: 'request', id: '1', method: 'bookmarks/save', params: undefined });
      await waitUntil(() => Boolean(findResponse(posted, '1')));

      const messages = (global as unknown as { __testWindowMessages: { warning: string[] } }).__testWindowMessages;
      expect(messages.warning).to.have.lengthOf(1);
      expect(store.listSetNames()).to.deep.equal([]);
    });

    it('bookmarks/load replaces the current selection with the bookmark', async () => {
      await store.saveNamedSet('Existing', ['src/index.ts']);
      const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
      const { view, posted, trigger } = fakeView();
      provider.resolveWebviewView(view);

      trigger({ kind: 'request', id: '1', method: 'bookmarks/load', params: { name: 'Existing' } });
      await waitUntil(() => Boolean(findResponse(posted, '1')));

      expect(model.getSelection()).to.deep.equal(['src/index.ts']);
    });

    it('bookmarks/delete removes the named set and pushes the updated list', async () => {
      await store.saveNamedSet('ToDelete', ['README.md']);
      const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
      const { view, posted, trigger } = fakeView();
      provider.resolveWebviewView(view);

      trigger({ kind: 'request', id: '1', method: 'bookmarks/delete', params: { name: 'ToDelete' } });
      await waitUntil(() => Boolean(findResponse(posted, '1')));

      expect(store.listSetNames()).to.deep.equal([]);
      const bookmarksEvent = posted.find(
        (m) => (m as { kind?: string; event?: string }).kind === 'event' && (m as { event?: string }).event === 'bookmarks',
      ) as { payload: unknown[] } | undefined;
      expect(bookmarksEvent?.payload).to.deep.equal([]);
    });

    it('bookmarks/overrideWithCurrent replaces the bookmark contents with the current selection', async () => {
      await store.saveNamedSet('ToOverride', ['README.md']);
      const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
      const { view, posted, trigger } = fakeView();
      provider.resolveWebviewView(view);
      await model.toggleFile('src/index.ts', true);

      trigger({ kind: 'request', id: '1', method: 'bookmarks/overrideWithCurrent', params: { name: 'ToOverride' } });
      await waitUntil(() => Boolean(findResponse(posted, '1')));

      expect(store.getNamedSet('ToOverride')).to.deep.equal(['src/index.ts']);
    });
  });

  it('pushes a tree/invalidated event when the model changes', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
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

  it('persists the selection to the store as it changes (post-cutover: this is the only tree left)', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
    const { view } = fakeView();
    provider.resolveWebviewView(view);

    // The shared vscode stub's getConfiguration() always returns whatever
    // default the caller passes — selectionMemory's own default is
    // 'lastOnly', so persistence is exercised unconditionally in this
    // harness (see setup.js's workspace.getConfiguration comment).
    await model.toggleFile('README.md', true);
    await waitUntil(() => (store.getLastSelection() ?? []).includes('README.md'));
    expect(store.getLastSelection()).to.deep.equal(['README.md']);

    await model.toggleFile('README.md', false);
    await waitUntil(() => (store.getLastSelection() ?? []).length === 0);
    expect(store.getLastSelection()).to.deep.equal([]);
  });

  it('runGenerate() runs the same generate pipeline as the actions/generate bridge handler', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
    const { view, posted } = fakeView();
    provider.resolveWebviewView(view);

    // No workspace root -> undefined for this instance would use root, so
    // exercise the "nothing selected" error path instead, verifying
    // runGenerate() reaches the same emit('error', ...) actions/generate does.
    await provider.runGenerate();

    const errorEvent = posted.find(
      (m) => (m as { kind?: string; event?: string }).kind === 'event' && (m as { event?: string }).event === 'error',
    ) as { payload: { message: string } } | undefined;
    expect(errorEvent?.payload.message).to.equal('Select at least one file before generating.');
  });

  it('refresh() re-reads the tree, invalidates the repo-root cache, and pushes updated state — exposed for the aiHandoff.refreshTree command', async () => {
    const provider = new HandoffPanelProvider({ fsPath: '/fake/ext' } as never, model, store, root);
    const { view, posted } = fakeView();
    provider.resolveWebviewView(view);

    expect(() => provider.refresh()).to.not.throw();

    const isEvent = (name: string) => (m: unknown) =>
      (m as { kind?: string; event?: string }).kind === 'event' && (m as { event?: string }).event === name;

    await waitUntil(() => posted.some(isEvent('tree/invalidated')));
    expect(
      posted.some(isEvent('tree/invalidated')),
      'model.refresh() should fire onDidChangeTree, surfaced as tree/invalidated',
    ).to.be.true;

    await waitUntil(() => posted.some(isEvent('state')));
    expect(posted.some(isEvent('state')), 'refresh() should also push fresh stats').to.be.true;
  });
});
