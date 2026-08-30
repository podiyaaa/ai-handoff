/**
 * Fakes the extension host side of the bridge for standalone browser
 * development — see webview-ui/dev.html. NOT shipped in the .vsix and never
 * loaded by the real extension; this exists purely so the webview UI
 * (media/webview/*.js) can be iterated on in a plain browser — edit, hit
 * refresh — without launching the Extension Development Host each time.
 *
 * Intercepts every outgoing request the same way the real host does: it
 * always replies with exactly one response (ok or error) — via
 * `window.postMessage`, so the real bridge-client.js code path (which only
 * ever listens for postMessage'd envelopes) is exercised completely
 * unmodified. Nothing about bridge-client.js knows or cares that the other
 * side of the wire is this mock instead of the real host.
 */
(function () {
  function node(relativePath, isDirectory) {
    var parts = relativePath.split('/');
    return {
      relativePath: relativePath,
      name: parts[parts.length - 1],
      isDirectory: isDirectory,
      checkboxState: 'unchecked',
      matchesSearch: false,
    };
  }

  // A tiny canned tree, keyed by parent path ('' = root), matching the
  // real tree/getChildren contract (see src/core/bridge-protocol.ts).
  var tree = {
    '': [node('src', true), node('README.md', false)],
    src: [node('src/index.ts', false), node('src/utils', true)],
    'src/utils': [node('src/utils/format.ts', false)],
  };

  var bookmarks = [
    { name: 'Auth module', fileCount: 4 },
    { name: 'API layer', fileCount: 9 },
  ];

  var skipped = [
    { relativePath: 'dist/bundle.js', reason: 'smart-filter', detail: 'matched a default junk pattern' },
  ];

  // One canned handler per BridgeMethods entry — adding a real one here
  // when a new bridge method is introduced keeps the dev harness usable
  // for that capability too, same "one more line" spirit as the real bridge.
  var handlers = {
    'tree/getChildren': function (params) {
      return tree[(params && params.path) || ''] || [];
    },
    'tree/toggleFile': function () {
      return undefined;
    },
    'tree/toggleDirectory': function () {
      return undefined;
    },
    'tree/toggleExpand': function () {
      return undefined;
    },
    'tree/setSearchQuery': function () {
      return { error: undefined };
    },
    'actions/setFormat': function () {
      return undefined;
    },
    'actions/setInstructions': function () {
      return undefined;
    },
    'actions/setDiffEnabled': function () {
      return undefined;
    },
    'actions/setDiffScope': function () {
      return undefined;
    },
    'actions/generate': function () {
      return undefined;
    },
    'actions/overrideFile': function () {
      return undefined;
    },
    'bookmarks/save': function () {
      return undefined;
    },
    'bookmarks/load': function () {
      return undefined;
    },
    'bookmarks/delete': function () {
      return undefined;
    },
    'bookmarks/overrideWithCurrent': function () {
      return undefined;
    },
    'native/showInputBox': function (params) {
      var value = window.prompt(params.prompt, params.value || '');
      return value === null ? undefined : value;
    },
    'native/showQuickPick': function (params) {
      var pick = window.prompt((params.placeholder || 'Pick one') + '\n' + params.items.join(', '));
      return params.items.indexOf(pick) === -1 ? undefined : pick;
    },
    'file/open': function () {
      return undefined;
    },
  };

  function createMockVscodeApi() {
    return {
      postMessage: function (envelope) {
        if (!envelope || envelope.kind !== 'request') {
          return;
        }
        // Reply asynchronously, like a real extension-host round-trip —
        // catches bugs that only show up when a caller assumes the
        // response is synchronous.
        setTimeout(function () {
          try {
            var handler = handlers[envelope.method];
            if (!handler) {
              throw new Error('mock-bridge: no canned handler for "' + envelope.method + '"');
            }
            var result = handler(envelope.params);
            window.postMessage({ kind: 'response', id: envelope.id, ok: true, result: result }, '*');
          } catch (e) {
            window.postMessage(
              { kind: 'response', id: envelope.id, ok: false, error: { message: e.message } },
              '*',
            );
          }
        }, 30);
      },
      getState: function () {
        return undefined;
      },
      setState: function () {},
    };
  }

  /** Pushes a canned initial `state`/`bookmarks` event, mirroring activation. */
  function pushInitialState() {
    setTimeout(function () {
      window.postMessage(
        {
          kind: 'event',
          event: 'state',
          payload: {
            stats: { fileCount: 3, totalSizeBytes: 4096, estimatedTokens: 512, diffFileCount: 0 },
            format: 'xml',
            showCustomInstructions: false,
            instructions: '',
            skipped: skipped,
            gitDiffEnabled: false,
            diffScope: 'working',
          },
        },
        '*',
      );
      window.postMessage({ kind: 'event', event: 'bookmarks', payload: bookmarks }, '*');
    }, 30);
  }

  window.AiHandoffMockBridge = {
    createMockVscodeApi: createMockVscodeApi,
    pushInitialState: pushInitialState,
  };
})();
