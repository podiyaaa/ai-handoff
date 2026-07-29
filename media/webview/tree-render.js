/**
 * DOM-touching half of the virtualized tree render. Deliberately NOT
 * unit-tested (no jsdom in this repo — see the module doc in
 * src/test/unit/bridge-client.test.ts) — all index/offset math is delegated
 * to virtual-list.js (which is unit-tested); this file only ever creates,
 * positions, and updates DOM nodes for whatever range that math says is
 * visible. Verify by hand: F5 (Extension Development Host) against a large
 * fixture, or via webview-ui/dev.html for layout/behavior iteration.
 *
 * Navigation: clicking a directory row expands/collapses it; clicking a
 * file row opens it (file/open), matching the old native TreeView's
 * per-item vscode.open command. Selection: the per-row checkbox calls
 * tree/toggleFile or tree/toggleDirectory depending on the row's
 * isDirectory flag, matching FileTreeModel's own split API. The actions
 * footer comes in a later stage, reusing this same render loop.
 *
 * Takes an already-constructed `bridge` rather than calling
 * acquireVsCodeApi()/createBridge() itself — acquireVsCodeApi() throws if
 * called more than once per webview, and search-render.js needs the same
 * bridge instance, so main.js constructs it once and passes it to both.
 */
(function () {
  var ROW_HEIGHT = 22; // matches VS Code's own tree row height
  var OVERSCAN = 8;

  function init(bridge) {
    var VirtualList = window.AiHandoffVirtualList;

    var scrollEl = document.getElementById('tree-scroll');
    var spacerEl = document.getElementById('tree-spacer');
    var clearSelectionBtn = document.getElementById('clear-selection');
    var showSelectedOnlyBtn = document.getElementById('show-selected-only');
    var collapseAllBtn = document.getElementById('collapse-all');
    var refreshBtn = document.getElementById('refresh');

    /** Flat, ordered TreeNodeInfo[] from the host — see FileTreeModel.getVisibleRows(). */
    var rows = [];
    /** relativePath -> { el, index, data } for whatever's currently in the DOM. */
    var rendered = new Map();
    /** Mirrors expand state locally just so the disclosure icon can flip instantly on click. */
    var expandedCache = Object.create(null);
    var rafHandle = null;
    /**
     * Roving tabindex: the relativePath of the row that's tabindex="0" (all
     * others are "-1"), persisted by path (not DOM element or index) since
     * virtualization recycles/removes row elements as they scroll out —
     * unlike a native tree, a stale DOM reference or index wouldn't survive
     * a scroll or a fresh getVisibleRows() result. Kept in sync by
     * applyRovingTabindex(), called after every render() and on click.
     */
    var focusedPath = null;
    var rowIdCounter = 0;

    function depthOf(relativePath) {
      return relativePath.split('/').length - 1;
    }

    function findRowIndexByPath(relativePath) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].relativePath === relativePath) {
          return i;
        }
      }
      return -1;
    }

    /**
     * Exactly one rendered row gets tabindex="0" (and aria-selected="true",
     * repurposed here to mean "the currently active tree row" rather than
     * checkbox state — the checkbox already exposes inclusion state on its
     * own). If focusedPath's row isn't currently rendered (e.g. the user
     * scrolled it out of view with the mouse wheel, without moving focus),
     * fall back to the first rendered row so the tree stays Tab-reachable.
     */
    function applyRovingTabindex() {
      var found = false;
      var first = null;
      rendered.forEach(function (entry) {
        if (!first || entry.index < first.index) {
          first = entry;
        }
        var isFocused = entry.data.relativePath === focusedPath;
        entry.el.tabIndex = isFocused ? 0 : -1;
        entry.el.setAttribute('aria-selected', String(isFocused));
        if (isFocused) {
          found = true;
        }
      });
      if (!found && first) {
        first.el.tabIndex = 0;
        first.el.setAttribute('aria-selected', 'true');
      }
    }

    function makeRowElement() {
      var row = document.createElement('div');
      row.className = 'tree-row';
      row.setAttribute('role', 'treeitem');
      row.tabIndex = -1;
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'tree-row-checkbox';
      // Removed from the normal Tab sequence — the row itself is the one
      // tab stop per item (roving tabindex); Space, handled below on the
      // row, toggles this checkbox instead of relying on the browser's
      // default checkbox-focused Space behavior.
      checkbox.tabIndex = -1;
      var icon = document.createElement('span');
      icon.className = 'codicon tree-row-icon';
      icon.setAttribute('aria-hidden', 'true'); // decorative — the row's accessible name comes from the label
      var label = document.createElement('span');
      label.className = 'tree-row-label';
      label.id = 'tree-row-label-' + rowIdCounter++;
      checkbox.setAttribute('aria-labelledby', label.id);
      row.appendChild(checkbox);
      row.appendChild(icon);
      row.appendChild(label);

      checkbox.addEventListener('click', function (e) {
        // Don't also let this bubble into the row's own click handler below
        // (which would toggle expand/collapse for a directory row).
        e.stopPropagation();
        var data = row.__data;
        if (!data) {
          return;
        }
        focusedPath = data.relativePath;
        applyRovingTabindex();
        toggleChecked(data, checkbox.checked);
      });

      row.addEventListener('click', function () {
        var data = row.__data;
        if (!data) {
          return;
        }
        focusedPath = data.relativePath;
        applyRovingTabindex();
        if (data.isDirectory) {
          toggleExpand(data.relativePath, !row.__expanded);
        } else {
          bridge.call('file/open', { path: data.relativePath });
        }
      });
      return row;
    }

    function updateRowElement(row, data, index) {
      row.__data = data;
      row.__expanded = Boolean(expandedCache[data.relativePath]);
      row.style.top = index * ROW_HEIGHT + 'px';
      row.style.height = ROW_HEIGHT + 'px';
      row.style.paddingLeft = 8 + depthOf(data.relativePath) * 16 + 'px';
      row.className = 'tree-row' + (data.isDirectory ? ' tree-row-dir' : ' tree-row-file');
      row.setAttribute('aria-level', String(depthOf(data.relativePath) + 1));
      if (data.isDirectory) {
        row.setAttribute('aria-expanded', String(row.__expanded));
      } else {
        row.removeAttribute('aria-expanded');
      }
      var checkbox = row.childNodes[0];
      var icon = row.childNodes[1];
      var label = row.childNodes[2];
      checkbox.checked = data.checkboxState === 'checked';
      // codicon-chevron-down / codicon-chevron-right glyphs, matching VS
      // Code's own tree twisties rather than plain Unicode triangles.
      icon.textContent = data.isDirectory ? (row.__expanded ? '\uEAB4' : '\uEAB6') : '';
      label.textContent = data.name;
      label.title = data.relativePath;
    }

    function render() {
      rafHandle = null;
      var viewportHeight = scrollEl.clientHeight;
      var scrollTop = scrollEl.scrollTop;
      var range = VirtualList.computeVisibleRange({
        scrollTop: scrollTop,
        viewportHeight: viewportHeight,
        rowHeight: ROW_HEIGHT,
        totalRows: rows.length,
        overscan: OVERSCAN,
      });

      spacerEl.style.height = range.totalHeight + 'px';

      // Drop anything that scrolled out of the window, or whose underlying
      // data changed (a fresh getVisibleRows() always returns new objects,
      // so reference inequality means "this row needs updating", not just
      // "moved" — e.g. its checkbox/expand state changed).
      rendered.forEach(function (entry, key) {
        if (entry.index < range.startIndex || entry.index >= range.endIndex || rows[entry.index] !== entry.data) {
          entry.el.remove();
          rendered.delete(key);
        }
      });

      for (var i = range.startIndex; i < range.endIndex; i++) {
        var data = rows[i];
        if (!data) {
          continue;
        }
        var existing = rendered.get(data.relativePath);
        if (existing && existing.index === i && existing.data === data) {
          continue;
        }
        var rowEl = existing ? existing.el : makeRowElement();
        updateRowElement(rowEl, data, i);
        if (!existing) {
          spacerEl.appendChild(rowEl);
        }
        rendered.set(data.relativePath, { el: rowEl, index: i, data: data });
      }

      applyRovingTabindex();
    }

    function scheduleRender() {
      if (rafHandle !== null) {
        return;
      }
      rafHandle = requestAnimationFrame(render);
    }

    function refetchAndRender() {
      bridge.call('tree/getVisibleRows', undefined).then(function (newRows) {
        rows = newRows;
        scheduleRender();
      });
    }

    function toggleExpand(relativePath, expanded) {
      expandedCache[relativePath] = expanded;
      // Flip the icon immediately without waiting for the round trip — the
      // authoritative row list still comes from refetchAndRender() below.
      scheduleRender();
      bridge.call('tree/toggleExpand', { path: relativePath, expanded: expanded }).then(refetchAndRender);
    }

    /**
     * Ticking a file selects just that file; ticking a directory selects
     * all its descendant files (recursively) — matches
     * FileTreeModel.toggleFile/toggleDirectory exactly, which is why this
     * picks the bridge method by the row's own isDirectory flag rather than
     * having one combined "toggle" method.
     */
    function toggleChecked(data, checked) {
      var method = data.isDirectory ? 'tree/toggleDirectory' : 'tree/toggleFile';
      bridge.call(method, { path: data.relativePath, checked: checked }).then(refetchAndRender);
    }

    /**
     * Move focus to row `index`, scrolling it into view first — a row
     * outside the current virtualized window isn't in the DOM at all yet,
     * the classic virtualization-plus-focus bug (see virtual-list.js's
     * scrollOffsetForIndex doc). render() is called synchronously (not via
     * scheduleRender()'s rAF deferral) so the target row exists before
     * .focus() is called on it.
     */
    function focusRowAtIndex(index) {
      if (index < 0 || index >= rows.length) {
        return;
      }
      var data = rows[index];
      focusedPath = data.relativePath;
      var newScrollTop = VirtualList.scrollOffsetForIndex({
        index: index,
        rowHeight: ROW_HEIGHT,
        viewportHeight: scrollEl.clientHeight,
        currentScrollTop: scrollEl.scrollTop,
      });
      if (newScrollTop !== scrollEl.scrollTop) {
        scrollEl.scrollTop = newScrollTop;
      }
      render();
      var entry = rendered.get(data.relativePath);
      if (entry) {
        entry.el.focus();
      }
    }

    /**
     * Delegated keydown on the tree container rather than per-row, since
     * rows are recycled/removed as the user scrolls — a per-row listener
     * would need constant re-attachment. Scoped to `e.target === row` (not
     * just "inside" it) so a directly-mouse-focused checkbox keeps its own
     * native Space/Enter behavior instead of also triggering the row's
     * shortcuts (which would double-toggle the checkbox on Space).
     */
    function onTreeKeyDown(e) {
      var row = e.target.closest ? e.target.closest('.tree-row') : null;
      if (!row || !row.__data || e.target !== row) {
        return;
      }
      var data = row.__data;
      var index = findRowIndexByPath(data.relativePath);

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          focusRowAtIndex(index + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          focusRowAtIndex(index - 1);
          break;
        case 'Home':
          e.preventDefault();
          focusRowAtIndex(0);
          break;
        case 'End':
          e.preventDefault();
          focusRowAtIndex(rows.length - 1);
          break;
        case 'ArrowRight':
          if (data.isDirectory && !row.__expanded) {
            e.preventDefault();
            toggleExpand(data.relativePath, true);
          }
          break;
        case 'ArrowLeft':
          if (data.isDirectory && row.__expanded) {
            e.preventDefault();
            toggleExpand(data.relativePath, false);
          }
          break;
        case 'Enter':
          e.preventDefault();
          if (data.isDirectory) {
            toggleExpand(data.relativePath, !row.__expanded);
          } else {
            bridge.call('file/open', { path: data.relativePath });
          }
          break;
        case ' ':
        case 'Spacebar':
          e.preventDefault();
          var checkbox = row.childNodes[0];
          checkbox.checked = !checkbox.checked;
          toggleChecked(data, checkbox.checked);
          break;
      }
    }

    scrollEl.addEventListener('scroll', scheduleRender);
    window.addEventListener('resize', scheduleRender);
    // Delegated on the spacer (rows' shared parent) rather than per-row,
    // since virtualization recycles/removes row elements as the user scrolls.
    spacerEl.addEventListener('keydown', onTreeKeyDown);
    // Pushed by the host when the file watcher invalidates something, or a
    // search query changes what should be visible.
    bridge.on('tree/invalidated', refetchAndRender);
    // No local optimistic update needed here (unlike toggleExpand's icon
    // flip) — clearSelection() fires onDidChangeTree host-side, which
    // pushes tree/invalidated and lands us back in refetchAndRender anyway.
    clearSelectionBtn.addEventListener('click', function () {
      bridge.call('tree/clearSelection', undefined);
    });

    // Starts unpressed on every load — same "resets on launch" convention
    // as the selection itself; nothing here needs restoring from state.
    var showSelectedOnly = false;
    showSelectedOnlyBtn.addEventListener('click', function () {
      showSelectedOnly = !showSelectedOnly;
      showSelectedOnlyBtn.setAttribute('aria-pressed', String(showSelectedOnly));
      bridge.call('tree/setShowSelectedOnly', { enabled: showSelectedOnly }).then(refetchAndRender);
    });

    // No "expand all" counterpart, by design (see FileTreeModel.collapseAll's
    // doc). collapseAll() also turns off "show selected only" host-side
    // (that filter force-auto-expands every ancestor, so collapsing while
    // it's still on would silently do nothing) — mirror that locally so the
    // toggle button's pressed state doesn't lie about what's actually on.
    collapseAllBtn.addEventListener('click', function () {
      expandedCache = Object.create(null);
      if (showSelectedOnly) {
        showSelectedOnly = false;
        showSelectedOnlyBtn.setAttribute('aria-pressed', 'false');
      }
      bridge.call('tree/collapseAll', undefined).then(refetchAndRender);
    });

    // No .then(refetchAndRender) needed — actions/refresh's model.refresh()
    // fires onDidChangeTree host-side, same as clearSelection above, which
    // lands us back in refetchAndRender via the tree/invalidated listener.
    refreshBtn.addEventListener('click', function () {
      bridge.call('actions/refresh', undefined);
    });

    refetchAndRender();
  }

  window.AiHandoffTreeRender = { init: init };
})();
