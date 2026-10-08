/**
 * "Generate from branch diff" wiring — two branch dropdowns + its own
 * Generate button, entirely independent of the sidebar tree selection.
 * Sibling to actions-render.js, same init(bridge) shape (bridge is already
 * constructed — acquireVsCodeApi() can only be called once per webview).
 */
(function () {
  function init(bridge) {
    var $base = document.getElementById('refdiff-base');
    var $compare = document.getElementById('refdiff-compare');
    var $generate = document.getElementById('refdiff-generate');
    var $fields = document.getElementById('refdiff-fields');
    var $noRepo = document.getElementById('refdiff-no-repo');

    function populate(select, branches, selected) {
      select.innerHTML = '';
      var placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select a branch…';
      select.appendChild(placeholder);
      branches.forEach(function (branch) {
        var option = document.createElement('option');
        option.value = branch;
        option.textContent = branch;
        select.appendChild(option);
      });
      select.value = branches.indexOf(selected) !== -1 ? selected : '';
    }

    function loadBranches(selectedBase, selectedCompare) {
      bridge.call('refDiff/listBranches', undefined).then(function (result) {
        $fields.classList.toggle('hidden', !result.repoFound);
        $noRepo.classList.toggle('hidden', result.repoFound);
        populate($base, result.branches, selectedBase);
        populate($compare, result.branches, selectedCompare);
      });
    }

    $base.addEventListener('change', function () {
      bridge.call('refDiff/setBaseRef', { ref: $base.value });
    });
    $compare.addEventListener('change', function () {
      bridge.call('refDiff/setCompareRef', { ref: $compare.value });
    });
    $generate.addEventListener('click', function () {
      bridge.call('refDiff/generate', undefined);
    });

    bridge.on('actions/generating', function (payload) {
      $generate.disabled = payload.busy;
      $generate.textContent = payload.busy ? 'Generating…' : 'Generate from branch diff';
    });

    // Keep the two selects in sync with host state after the initial load
    // (e.g. if something else ever changes refDiffBaseRef/CompareRef) —
    // but never re-list branches here, since the branch list itself rarely
    // changes mid-session; loadBranches() below is the one-time fetch.
    bridge.on('state', function (state) {
      if (document.activeElement !== $base) {
        $base.value = state.refDiffBaseRef;
      }
      if (document.activeElement !== $compare) {
        $compare.value = state.refDiffCompareRef;
      }
    });

    // Fetch the initial state directly as this call's result, same reason
    // actions-render.js uses actions/ready rather than the state push event:
    // a push emitted before this listener registered would be silently lost.
    bridge.call('actions/ready', undefined).then(function (result) {
      loadBranches(result.state.refDiffBaseRef, result.state.refDiffCompareRef);
    });
  }

  window.AiHandoffRefDiffRender = { init: init };
})();
