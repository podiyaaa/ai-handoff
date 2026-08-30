import { expect } from 'chai';
import * as sinon from 'sinon';

// Plain JS, no framework, no build step — see the module doc in
// media/webview/bridge-client.js. Loaded via dynamic import() rather than
// require(): this test environment runs .ts specs through Node's native
// ESM loader, where `require` isn't defined; import() works uniformly for
// both CommonJS and ESM targets (a plain .js file with no package.json
// "type" is loaded as CommonJS, exposed as the default export).
type CreateBridge = (
  vscodeApi: { postMessage: (m: unknown) => void },
  messageTarget?: unknown,
) => {
  call: (method: string, params: unknown) => Promise<unknown>;
  on: (event: string, fn: (payload: unknown) => void) => void;
  dispose: () => void;
};
let createBridge: CreateBridge;

// A non-literal specifier so TypeScript can't (and doesn't try to) resolve
// declarations for this plain, un-typed .js asset — it's fine for this
// dynamic import to type as `any`; the `CreateBridge` cast right after
// re-establishes the exact shape this test relies on.
const bridgeClientPath = '../../../media/webview/bridge-client.js';

before(async () => {
  const mod = (await import(bridgeClientPath)) as unknown as {
    default: { createBridge: CreateBridge };
  };
  createBridge = mod.default.createBridge;
});

interface FakeMessageEvent {
  data: unknown;
}
type Listener = (event: FakeMessageEvent) => void;

function fakeMessageTarget(): {
  addEventListener: (type: string, fn: Listener) => void;
  removeEventListener: (type: string, fn: Listener) => void;
  dispatch: (type: string, data: unknown) => void;
} {
  const listeners: Record<string, Listener[]> = {};
  return {
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    dispatch(type, data) {
      for (const fn of listeners[type] || []) {
        fn({ data });
      }
    },
  };
}

function fakeVscodeApi(): { postMessage: (m: unknown) => void; posted: unknown[] } {
  const posted: unknown[] = [];
  return { posted, postMessage: (m: unknown) => posted.push(m) };
}

describe('bridge-client (webview-side)', () => {
  it('call() posts a well-formed request envelope', () => {
    const target = fakeMessageTarget();
    const vscodeApi = fakeVscodeApi();
    const bridge = createBridge(vscodeApi, target);

    void bridge.call('tree/getChildren', { path: undefined });

    expect(vscodeApi.posted).to.have.lengthOf(1);
    expect(vscodeApi.posted[0]).to.deep.include({
      kind: 'request',
      method: 'tree/getChildren',
      params: { path: undefined },
    });
  });

  it('call() resolves with the result on an ok response', async () => {
    const target = fakeMessageTarget();
    const vscodeApi = fakeVscodeApi();
    const bridge = createBridge(vscodeApi, target);

    const promise = bridge.call('tree/getChildren', { path: undefined });
    const id = (vscodeApi.posted[0] as { id: string }).id;
    target.dispatch('message', { kind: 'response', id, ok: true, result: ['a.ts'] });

    expect(await promise).to.deep.equal(['a.ts']);
  });

  it('call() rejects with the error message on a not-ok response', async () => {
    const target = fakeMessageTarget();
    const vscodeApi = fakeVscodeApi();
    const bridge = createBridge(vscodeApi, target);

    const promise = bridge.call('actions/generate', undefined);
    const id = (vscodeApi.posted[0] as { id: string }).id;
    target.dispatch('message', { kind: 'response', id, ok: false, error: { message: 'boom' } });

    try {
      await promise;
      expect.fail('expected the promise to reject');
    } catch (e) {
      expect((e as Error).message).to.equal('boom');
    }
  });

  it('rejects with a diagnostic message if no response ever arrives (timeout)', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const target = fakeMessageTarget();
      const vscodeApi = fakeVscodeApi();
      const bridge = createBridge(vscodeApi, target);

      const promise = bridge.call('actions/generate', undefined);
      const assertion = promise.then(
        () => {
          throw new Error('expected the promise to reject');
        },
        (e: Error) => e,
      );
      await clock.tickAsync(15000);
      const err = await assertion;
      expect(err.message).to.include('no response');
      expect(err.message).to.include('actions/generate');
    } finally {
      clock.restore();
    }
  });

  it('ignores a response with an id that was never requested (or already resolved)', () => {
    const target = fakeMessageTarget();
    const vscodeApi = fakeVscodeApi();
    createBridge(vscodeApi, target);

    // Must not throw for an unrecognized/stale id.
    expect(() =>
      target.dispatch('message', { kind: 'response', id: 'never-requested', ok: true, result: null }),
    ).to.not.throw();
  });

  it('ignores malformed messages without a recognized "kind"', () => {
    const target = fakeMessageTarget();
    const vscodeApi = fakeVscodeApi();
    createBridge(vscodeApi, target);

    expect(() => target.dispatch('message', { foo: 'bar' })).to.not.throw();
    expect(() => target.dispatch('message', null)).to.not.throw();
    expect(() => target.dispatch('message', 'not an object')).to.not.throw();
  });

  it('on() delivers pushed events to every registered listener', () => {
    const target = fakeMessageTarget();
    const vscodeApi = fakeVscodeApi();
    const bridge = createBridge(vscodeApi, target);

    const received: unknown[] = [];
    bridge.on('tree/invalidated', (payload: unknown) => received.push(payload));
    bridge.on('tree/invalidated', (payload: unknown) => received.push(payload));
    target.dispatch('message', { kind: 'event', event: 'tree/invalidated', payload: { path: 'src' } });

    expect(received).to.deep.equal([{ path: 'src' }, { path: 'src' }]);
  });

  it('dispose() stops listening for further messages', async () => {
    const target = fakeMessageTarget();
    const vscodeApi = fakeVscodeApi();
    const bridge = createBridge(vscodeApi, target);

    const received: unknown[] = [];
    bridge.on('tree/invalidated', (payload: unknown) => received.push(payload));
    bridge.dispose();
    target.dispatch('message', { kind: 'event', event: 'tree/invalidated', payload: { path: 'src' } });

    expect(received).to.deep.equal([]);
  });
});
