/**
 * DOM-touching half of the virtualized tree render. Deliberately NOT
 * unit-tested (no jsdom in this repo — see the module doc in
 * src/test/unit/bridge-client.test.ts) — all index/offset math is delegated
 * to virtual-list.js (which is unit-tested); this file only ever creates,
 * positions, and updates DOM nodes for whatever range that math says is
 * visible. Verify by hand: F5 (Extension Development Host) against a large
 * fixture, or via webview-ui/dev.html for layout/behavior iteration.
 *
 * Navigation: clicking a directory row expands/collapses it. Selection: the
 * per-row checkbox calls tree/toggleFile or tree/toggleDirectory depending
 * on the row's isDirectory flag, matching FileTreeModel's own split API.
 * Search and the actions footer come in later stages, reusing this same
 * render loop.
 */
(function () {
  var ROW_HEIGHT = 22; // matches VS Code's own tree row height
  var OVERSCAN = 8;

  function init() {
    var vscodeApi = acquireVsCodeApi();
    var bridge = window.AiHandoffBridge.createBridge(vscodeApi);
    var VirtualList = window.AiHandoffVirtualList;

    var scrollEl = document.getElementById('tree-scroll');
    var spacerEl = document.getElementById('tree-spacer');

    /** Flat, ordered TreeNodeInfo[] from the host — see FileTreeModel.getVisibleRows(). */
    var rows = [];
    /** relativePath -> { el, index, data } for whatever's currently in the DOM. */
    var rendered = new Map();
    /** Mirrors expand state locally just so the disclosure icon can flip instantly on click. */
    var expandedCache = Object.create(null);
    var rafHandle = null;

    function depthOf(relativePath) {
      return relativePath.split('/').length - 1;
    }

    function makeRowElement() {
      var row = document.createElement('div');
      row.className = 'tree-row';
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'tree-row-checkbox';
      var icon = document.createElement('span');
      icon.className = 'tree-row-icon';
      var label = document.createElement('span');
      label.className = 'tree-row-label';
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
        toggleChecked(data, checkbox.checked);
      });

      row.addEventListener('click', function () {
        var data = row.__data;
        if (data && data.isDirectory) {
          toggleExpand(data.relativePath, !row.__expanded);
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
      var checkbox = row.childNodes[0];
      var icon = row.childNodes[1];
      var label = row.childNodes[2];
      checkbox.checked = data.checkboxState === 'checked';
      icon.textContent = data.isDirectory ? (row.__expanded ? '▾' : '▸') : '';
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

    scrollEl.addEventListener('scroll', scheduleRender);
    window.addEventListener('resize', scheduleRender);
    // Pushed by the host when the file watcher invalidates something, or a
    // search query changes what should be visible.
    bridge.on('tree/invalidated', refetchAndRender);

    refetchAndRender();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
