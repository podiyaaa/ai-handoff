/**
 * Pure windowing math for the virtualized tree render — no DOM access at
 * all, deliberately, so this half of virtualization is unit-testable
 * (see src/test/unit/virtual-list.test.ts) while the DOM-touching half
 * (tree-render.js) isn't.
 *
 * What "rows exist" (expand state × lazy children × search) stays host-side
 * (FileTreeModel.getVisibleRows()) — this file only ever answers "given an
 * already-flat row array and a scroll position, which index range is
 * visible?". Deliberately fixed row height (not variable/measured) — that's
 * what keeps this arithmetic this simple; a future variable-height
 * requirement would need a materially different (cumulative-offset)
 * approach here, not an incremental tweak.
 */
(function (root) {
  /**
   * @param {{scrollTop: number, viewportHeight: number, rowHeight: number, totalRows: number, overscan?: number}} params
   * @returns {{startIndex: number, endIndex: number, offsetY: number, totalHeight: number}}
   */
  function computeVisibleRange(params) {
    var scrollTop = params.scrollTop;
    var viewportHeight = params.viewportHeight;
    var rowHeight = params.rowHeight;
    var totalRows = params.totalRows;
    var overscan = params.overscan || 0;

    var totalHeight = Math.max(0, totalRows) * Math.max(0, rowHeight);
    if (totalRows <= 0 || rowHeight <= 0) {
      return { startIndex: 0, endIndex: 0, offsetY: 0, totalHeight: totalHeight };
    }

    var startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    var endIndex = Math.min(totalRows, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
    if (endIndex < startIndex) {
      endIndex = startIndex;
    }

    return {
      startIndex: startIndex,
      endIndex: endIndex,
      offsetY: startIndex * rowHeight,
      totalHeight: totalHeight,
    };
  }

  /**
   * Where to scroll so row `index` is fully visible — scrolling up to align
   * its top with the viewport top if it's above the current view, or down
   * to align its bottom with the viewport bottom if it's below; unchanged
   * if it's already fully visible. Callers must scroll to this offset
   * *before* focusing the row, since a row outside the current window isn't
   * rendered at all yet — the classic virtualization bug this exists to avoid.
   *
   * @param {{index: number, rowHeight: number, viewportHeight: number, currentScrollTop: number}} params
   * @returns {number}
   */
  function scrollOffsetForIndex(params) {
    var index = params.index;
    var rowHeight = params.rowHeight;
    var viewportHeight = params.viewportHeight;
    var currentScrollTop = params.currentScrollTop;

    var rowTop = index * rowHeight;
    var rowBottom = rowTop + rowHeight;
    if (rowTop < currentScrollTop) {
      return rowTop;
    }
    if (rowBottom > currentScrollTop + viewportHeight) {
      return rowBottom - viewportHeight;
    }
    return currentScrollTop;
  }

  var api = { computeVisibleRange: computeVisibleRange, scrollOffsetForIndex: scrollOffsetForIndex };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.AiHandoffVirtualList = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
