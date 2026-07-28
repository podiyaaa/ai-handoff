import { expect } from 'chai';
import type { Webview } from 'vscode';
import type { RequestEnvelope, ResponseEnvelope, EventEnvelope } from '../../core/bridge-protocol';
import { HostBridge } from '../../ui/webview-host-bridge';

function fakeWebview(): {
  webview: Webview;
  posted: unknown[];
  trigger: (msg: unknown) => void;
} {
  const posted: unknown[] = [];
  let handler: ((msg: unknown) => void) | undefined;

  const webview = {
    onDidReceiveMessage: (cb: (msg: unknown) => void) => {
      handler = cb;
      // A real vscode.Disposable actually detaches the listener — model
      // that here, or the dispose() test below couldn't tell the
      // difference between "really disposed" and "just cleared handlers".
      return { dispose: () => { handler = undefined; } };
    },
    postMessage: (msg: unknown) => {
      posted.push(msg);
      return Promise.resolve(true);
    },
  };

  return {
    webview: webview as unknown as Webview,
    posted,
    trigger: (msg: unknown) => handler?.(msg),
  };
}

function request<M extends string>(id: string, method: M, params: unknown): RequestEnvelope {
  return { kind: 'request', id, method: method as never, params: params as never };
}

describe('HostBridge', () => {
  it('dispatches a registered handler and posts an ok response with its result', async () => {
    const { webview, posted, trigger } = fakeWebview();
    const bridge = new HostBridge(webview);
    bridge.handle('tree/getChildren', async ({ path }) => {
      expect(path).to.equal('src');
      return [{ relativePath: 'src/a.ts', name: 'a.ts', isDirectory: false, checkboxState: 'unchecked', matchesSearch: false }];
    });

    trigger(request('1', 'tree/getChildren', { path: 'src' }));
    // Handler is async — let its microtask settle before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    expect(posted).to.have.lengthOf(1);
    const response = posted[0] as ResponseEnvelope;
    expect(response).to.deep.equal({
      kind: 'response',
      id: '1',
      ok: true,
      result: [{ relativePath: 'src/a.ts', name: 'a.ts', isDirectory: false, checkboxState: 'unchecked', matchesSearch: false }],
    });
  });

  it('posts an error response (without crashing) when a handler throws', async () => {
    const { webview, posted, trigger } = fakeWebview();
    const bridge = new HostBridge(webview);
    bridge.handle('actions/generate', () => {
      throw new Error('disk on fire');
    });

    trigger(request('2', 'actions/generate', undefined));
    await new Promise((resolve) => setImmediate(resolve));

    expect(posted).to.deep.equal([
      { kind: 'response', id: '2', ok: false, error: { message: 'disk on fire' } },
    ]);
  });

  it('posts an error response for a method with no registered handler, instead of hanging', async () => {
    const { webview, posted, trigger } = fakeWebview();
    new HostBridge(webview);

    trigger(request('3', 'bookmarks/save', undefined));
    await new Promise((resolve) => setImmediate(resolve));

    expect(posted).to.have.lengthOf(1);
    const response = posted[0] as Extract<ResponseEnvelope, { ok: false }>;
    expect(response.ok).to.be.false;
    expect(response.error.message).to.include('bookmarks/save');
  });

  it('ignores messages that are not a well-formed request envelope', async () => {
    const { webview, posted, trigger } = fakeWebview();
    new HostBridge(webview);

    trigger({ foo: 'bar' });
    trigger(null);
    trigger({ kind: 'response', id: '1', ok: true, result: null }); // a response, not a request
    await new Promise((resolve) => setImmediate(resolve));

    expect(posted).to.deep.equal([]);
  });

  it('emit() posts a well-formed event envelope', () => {
    const { webview, posted } = fakeWebview();
    const bridge = new HostBridge(webview);

    bridge.emit('tree/invalidated', { path: 'src' });

    expect(posted).to.deep.equal([
      { kind: 'event', event: 'tree/invalidated', payload: { path: 'src' } } satisfies EventEnvelope,
    ]);
  });

  it('dispose() stops dispatching further requests', async () => {
    const { webview, posted, trigger } = fakeWebview();
    const bridge = new HostBridge(webview);
    bridge.handle('actions/generate', () => undefined);

    bridge.dispose();
    trigger(request('4', 'actions/generate', undefined));
    await new Promise((resolve) => setImmediate(resolve));

    expect(posted).to.deep.equal([]);
  });
});
