/**
 * Webview-side half of the bridge (see src/core/bridge-protocol.ts for the
 * wire format). Plain script, no framework, no build step — this exact file
 * ships inside the .vsix (loaded via <script src="..."> from the webview)
 * AND is directly require()-able from a unit test (see
 * src/test/unit/bridge-client.test.ts), so it must not assume either a
 * global `window` or a CommonJS `module` exists — it checks for each.
 *
 * createBridge(vscodeApi, messageTarget) takes the target to listen for
 * postMessage'd responses/events on as an explicit (optional) second
 * argument — defaulting to the global `window` when running in a real
 * webview — specifically so a unit test can pass in a small fake
 * addEventListener/removeEventListener object instead of faking `window`
 * wholesale.
 */
(function (root) {
  function createBridge(vscodeApi, messageTarget) {
    var target = messageTarget || (typeof window !== 'undefined' ? window : undefined);
    if (!target) {
      throw new Error('AI Handoff: no message target available (pass one explicitly outside a browser)');
    }

    var pending = new Map();
    var listeners = {};
    var nextId = 0;
    // 15s: without a timeout, a host-side bug that throws before replying
    // (or a future handler that forgets to resolve) leaves an awaited call
    // — e.g. a Generate button click — silently stuck forever with no
    // diagnostic at all.
    var REQUEST_TIMEOUT_MS = 15000;

    function handleMessage(event) {
      var msg = event.data;
      if (!msg || typeof msg !== 'object') {
        return;
      }
      if (msg.kind === 'response') {
        var entry = pending.get(msg.id);
        if (!entry) {
          return;
        }
        pending.delete(msg.id);
        clearTimeout(entry.timeout);
        if (msg.ok) {
          entry.resolve(msg.result);
        } else {
          entry.reject(new Error(msg.error && msg.error.message ? msg.error.message : 'AI Handoff: request failed'));
        }
      } else if (msg.kind === 'event') {
        var fns = listeners[msg.event];
        if (fns) {
          fns.slice().forEach(function (fn) {
            fn(msg.payload);
          });
        }
      }
    }

    target.addEventListener('message', handleMessage);

    return {
      /** Call a host method by name; resolves/rejects with its typed result. */
      call: function (method, params) {
        var id = String(nextId++);
        return new Promise(function (resolve, reject) {
          var timeout = setTimeout(function () {
            pending.delete(id);
            reject(
              new Error(
                'AI Handoff: no response for "' + method + '" (host may have thrown before replying)',
              ),
            );
          }, REQUEST_TIMEOUT_MS);
          pending.set(id, { resolve: resolve, reject: reject, timeout: timeout });
          vscodeApi.postMessage({ kind: 'request', id: id, method: method, params: params });
        });
      },
      /** Subscribe to a host-pushed event. */
      on: function (event, fn) {
        (listeners[event] = listeners[event] || []).push(fn);
      },
      /** Stop listening — mainly for tests; a real webview never needs this. */
      dispose: function () {
        target.removeEventListener('message', handleMessage);
        pending.forEach(function (entry) {
          clearTimeout(entry.timeout);
        });
        pending.clear();
      },
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createBridge: createBridge };
  } else {
    root.AiHandoffBridge = { createBridge: createBridge };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
