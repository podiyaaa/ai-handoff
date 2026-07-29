/**
 * Search input wiring for the merged sidebar webview. Mirrors the old
 * search-bar-panel.ts's client-side behavior exactly (debounced input,
 * inline error on an invalid query, clear button, Escape-to-clear) but
 * calls tree/setSearchQuery over the bridge instead of posting a raw
 * message directly — the host-side parseSearchQuery()/matchesSearchQuery()
 * logic is unchanged either way.
 *
 * Takes an already-constructed `bridge`, same reason as tree-render.js:
 * acquireVsCodeApi() can only be called once per webview, so main.js
 * constructs it once and shares it.
 */
(function () {
  function init(bridge) {
    var $input = document.getElementById('query');
    var $clear = document.getElementById('clear');
    var $hint = document.getElementById('hint');
    var $error = document.getElementById('error');

    var debounceHandle;
    var hasError = false;

    function send() {
      bridge.call('tree/setSearchQuery', { text: $input.value }).then(function (result) {
        hasError = Boolean(result.error);
        $input.classList.toggle('invalid', hasError);
        $error.textContent = result.error || '';
        $error.classList.toggle('hidden', !hasError);
        updateHintVisibility();
      });
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
    // actively using the box, so the header doesn't read as an oversized
    // empty box when idle.
    function updateHintVisibility() {
      var active = document.activeElement === $input || $input.value.length > 0;
      $hint.classList.toggle('hidden', hasError || !active);
    }

    $input.addEventListener('input', function () {
      $clear.classList.toggle('hidden', $input.value.length === 0);
      updateHintVisibility();
      scheduleSend();
    });

    $input.addEventListener('focus', updateHintVisibility);
    $input.addEventListener('blur', updateHintVisibility);

    $input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $input.value.length > 0) {
        e.stopPropagation();
        clear();
      }
    });

    $clear.addEventListener('click', function () {
      clear();
      $input.focus();
    });
  }

  window.AiHandoffSearchRender = { init: init };
})();
