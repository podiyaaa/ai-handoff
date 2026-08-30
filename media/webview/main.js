/**
 * Bootstrap for the merged sidebar webview. Calls acquireVsCodeApi() and
 * createBridge() exactly once — acquireVsCodeApi() throws if called more
 * than once per webview — and hands the one shared bridge instance to
 * each independent piece (search input, tree render, actions footer).
 * Loaded last (after bridge-client.js, virtual-list.js, tree-render.js,
 * search-render.js, actions-render.js all define their globals) since it's
 * the one that actually wires them together.
 */
(function () {
  function boot() {
    var vscodeApi = acquireVsCodeApi();
    var bridge = window.AiHandoffBridge.createBridge(vscodeApi);
    window.AiHandoffSearchRender.init(bridge);
    window.AiHandoffTreeRender.init(bridge);
    window.AiHandoffActionsRender.init(bridge);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
