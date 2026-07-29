/**
 * Actions footer wiring for the merged sidebar webview — format picker,
 * custom instructions, git diff controls, Generate/Refresh buttons,
 * bookmarks, and skipped files. Ported from the old action-panel.ts's
 * inline script, adapted to call bridge methods instead of posting raw
 * messages, and to the tiered/collapsible layout (see handoff-panel.ts's
 * renderHtml doc): Tier 1 (format/diff/generate/refresh/stats) is always
 * visible; Tier 2 (instructions + bookmarks + skipped) collapses as one
 * group, and within it, Bookmarks and Skipped files each have their own
 * independent collapsible header + bounded-height scroll region, so a long
 * list never grows the footer and squeezes the tree.
 *
 * Takes an already-constructed `bridge`, same reason as tree-render.js/
 * search-render.js: acquireVsCodeApi() can only be called once per webview.
 */
(function () {
  function init(bridge) {
    var $files = document.getElementById('stat-files');
    var $size = document.getElementById('stat-size');
    var $tokens = document.getElementById('stat-tokens');
    var $diffLabel = document.getElementById('stat-diff-label');
    var $diffFiles = document.getElementById('stat-diff-files');
    var $format = document.getElementById('format');
    var $diffEnabled = document.getElementById('diff-enabled');
    var $diffScope = document.getElementById('diff-scope');
    var $insWrap = document.getElementById('instructions-wrap');
    var $ins = document.getElementById('instructions');
    var $btn = document.getElementById('generate');
    var $refresh = document.getElementById('refresh');
    var $actionsError = document.getElementById('actions-error');
    var $bookmarkSave = document.getElementById('bookmark-save');
    var $bookmarksEmpty = document.getElementById('bookmarks-empty');
    var $bookmarkList = document.getElementById('bookmark-list');
    var $bookmarksCount = document.getElementById('bookmarks-count');
    var $skipCount = document.getElementById('skip-count');
    var $skipEmpty = document.getElementById('skip-empty');
    var $skipList = document.getElementById('skip-list');

    var $tier2Toggle = document.getElementById('tier2-toggle');
    var $tier2Body = document.getElementById('tier2-body');
    var $tier2Icon = document.getElementById('tier2-icon');
    var $bookmarksHeader = document.getElementById('bookmarks-header');
    var $bookmarksBody = document.getElementById('bookmarks-body');
    var $bookmarksIcon = document.getElementById('bookmarks-icon');
    var $skippedHeader = document.getElementById('skipped-header');
    var $skippedBody = document.getElementById('skipped-body');
    var $skippedIcon = document.getElementById('skipped-icon');

    var insDebounce;

    // codicon-chevron-right (\eab6, collapsed) / codicon-chevron-down (\eab4, expanded).
    function setCollapsed(bodyEl, iconEl, toggleEl, collapsed) {
      bodyEl.classList.toggle('collapsed', collapsed);
      iconEl.textContent = collapsed ? '\uEAB6' : '\uEAB4';
      toggleEl.setAttribute('aria-expanded', String(!collapsed));
    }

    function makeCollapsibleToggle(toggleEl, bodyEl, iconEl, initiallyCollapsed) {
      var collapsed = initiallyCollapsed;
      setCollapsed(bodyEl, iconEl, toggleEl, collapsed);
      toggleEl.addEventListener('click', function () {
        collapsed = !collapsed;
        setCollapsed(bodyEl, iconEl, toggleEl, collapsed);
      });
    }

    // All three start collapsed — the tree gets maximum space by default;
    // the user opts into seeing instructions/bookmarks/skipped.
    makeCollapsibleToggle($tier2Toggle, $tier2Body, $tier2Icon, true);
    makeCollapsibleToggle($bookmarksHeader, $bookmarksBody, $bookmarksIcon, true);
    makeCollapsibleToggle($skippedHeader, $skippedBody, $skippedIcon, true);

    $format.addEventListener('change', function () {
      bridge.call('actions/setFormat', { format: $format.value });
    });
    $diffEnabled.addEventListener('change', function () {
      $diffScope.classList.toggle('hidden', !$diffEnabled.checked);
      bridge.call('actions/setDiffEnabled', { enabled: $diffEnabled.checked });
    });
    $diffScope.addEventListener('change', function () {
      bridge.call('actions/setDiffScope', { scope: $diffScope.value });
    });
    $ins.addEventListener('input', function () {
      clearTimeout(insDebounce);
      insDebounce = setTimeout(function () {
        bridge.call('actions/setInstructions', { text: $ins.value });
      }, 200);
    });
    $btn.addEventListener('click', function () {
      bridge.call('actions/generate', undefined);
    });
    $refresh.addEventListener('click', function () {
      bridge.call('actions/refresh', undefined);
    });
    $bookmarkSave.addEventListener('click', function () {
      bridge.call('bookmarks/save', undefined);
    });

    function renderBookmarks(items) {
      $bookmarksCount.textContent = items.length;
      $bookmarkList.innerHTML = '';
      if (items.length === 0) {
        $bookmarksEmpty.classList.remove('hidden');
        return;
      }
      $bookmarksEmpty.classList.add('hidden');
      items.forEach(function (item) {
        var li = document.createElement('li');

        var name = document.createElement('span');
        name.className = 'bk-name';
        name.textContent = item.name;
        name.title = item.name;

        var count = document.createElement('span');
        count.className = 'bk-count';
        count.textContent = '(' + item.fileCount + ')';

        var load = document.createElement('a');
        load.className = 'action';
        load.textContent = '[load]';
        load.addEventListener('click', function (e) {
          e.preventDefault();
          bridge.call('bookmarks/load', { name: item.name });
        });

        var override = document.createElement('a');
        override.className = 'action';
        override.textContent = '[override]';
        override.addEventListener('click', function (e) {
          e.preventDefault();
          bridge.call('bookmarks/overrideWithCurrent', { name: item.name });
        });

        var del = document.createElement('a');
        del.className = 'action';
        del.textContent = '[delete]';
        del.addEventListener('click', function (e) {
          e.preventDefault();
          bridge.call('bookmarks/delete', { name: item.name });
        });

        li.appendChild(name);
        li.appendChild(count);
        li.appendChild(load);
        li.appendChild(override);
        li.appendChild(del);
        $bookmarkList.appendChild(li);
      });
    }

    function renderSkipped(items) {
      $skipCount.textContent = items.length;
      $skipList.innerHTML = '';
      if (items.length === 0) {
        $skipEmpty.classList.remove('hidden');
        return;
      }
      $skipEmpty.classList.add('hidden');
      items.forEach(function (item) {
        var li = document.createElement('li');
        var pathEl = document.createElement('span');
        pathEl.className = 'path';
        pathEl.textContent = item.relativePath;
        pathEl.title = item.detail ? item.reason + ' — ' + item.detail : item.reason;
        var detail = document.createElement('span');
        detail.className = 'detail';
        detail.textContent = item.detail || item.reason;
        var override = document.createElement('a');
        override.className = 'action';
        override.textContent = '[include anyway]';
        override.addEventListener('click', function (e) {
          e.preventDefault();
          bridge.call('actions/overrideFile', { path: item.relativePath });
        });
        li.appendChild(pathEl);
        li.appendChild(detail);
        li.appendChild(override);
        $skipList.appendChild(li);
      });
    }

    function applyState(state) {
      $files.textContent = state.stats.fileCount;
      $size.textContent = state.stats.sizeFormatted;
      $tokens.textContent = '~' + state.stats.tokensFormatted;
      $format.value = state.format;
      $diffEnabled.checked = state.gitDiffEnabled;
      $diffScope.value = state.diffScope;
      $diffScope.classList.toggle('hidden', !state.gitDiffEnabled);
      $diffLabel.classList.toggle('hidden', !state.gitDiffEnabled);
      $diffFiles.classList.toggle('hidden', !state.gitDiffEnabled);
      $diffFiles.textContent = state.stats.diffFileCount;
      if (state.showCustomInstructions) {
        $insWrap.classList.remove('hidden');
        if ($ins.value !== state.instructions) {
          $ins.value = state.instructions || '';
        }
      } else {
        $insWrap.classList.add('hidden');
      }
      renderSkipped(state.skipped);
      $actionsError.classList.add('hidden');
    }

    bridge.on('state', applyState);
    bridge.on('bookmarks', renderBookmarks);
    bridge.on('actions/generating', function (payload) {
      $btn.disabled = payload.busy;
      $btn.textContent = payload.busy ? 'Generating…' : 'Generate Handoff';
    });
    bridge.on('error', function (payload) {
      $actionsError.textContent = payload.message;
      $actionsError.classList.remove('hidden');
    });

    // Request the full current state once, directly as this call's result —
    // not via the state/bookmarks push events, which could otherwise fire
    // before this script has even registered its bridge.on() listeners
    // above and be silently lost.
    bridge.call('actions/ready', undefined).then(function (result) {
      applyState(result.state);
      renderBookmarks(result.bookmarks);
    });
  }

  window.AiHandoffActionsRender = { init: init };
})();
