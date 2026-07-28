import { expect } from 'chai';

// Plain JS, no framework, no build step — loaded via dynamic import() rather
// than require() (see the module doc in src/test/unit/bridge-client.test.ts
// for why: this test environment runs .ts specs through Node's native ESM
// loader, where `require` isn't defined).
interface VirtualListModule {
  computeVisibleRange: (params: {
    scrollTop: number;
    viewportHeight: number;
    rowHeight: number;
    totalRows: number;
    overscan?: number;
  }) => { startIndex: number; endIndex: number; offsetY: number; totalHeight: number };
  scrollOffsetForIndex: (params: {
    index: number;
    rowHeight: number;
    viewportHeight: number;
    currentScrollTop: number;
  }) => number;
}
let computeVisibleRange: VirtualListModule['computeVisibleRange'];
let scrollOffsetForIndex: VirtualListModule['scrollOffsetForIndex'];

const virtualListPath = '../../../media/webview/virtual-list.js';

before(async () => {
  const mod = (await import(virtualListPath)) as unknown as { default: VirtualListModule };
  ({ computeVisibleRange, scrollOffsetForIndex } = mod.default);
});

const ROW_HEIGHT = 22;

describe('computeVisibleRange', () => {
  it('at scrollTop 0, starts at row 0', () => {
    const result = computeVisibleRange({
      scrollTop: 0,
      viewportHeight: 220, // 10 rows
      rowHeight: ROW_HEIGHT,
      totalRows: 1000,
      overscan: 0,
    });
    expect(result.startIndex).to.equal(0);
    expect(result.endIndex).to.equal(10);
    expect(result.offsetY).to.equal(0);
    expect(result.totalHeight).to.equal(1000 * ROW_HEIGHT);
  });

  it('scrolled partway down, starts at the row containing scrollTop', () => {
    const result = computeVisibleRange({
      scrollTop: ROW_HEIGHT * 50, // exactly at the top of row 50
      viewportHeight: 220,
      rowHeight: ROW_HEIGHT,
      totalRows: 1000,
      overscan: 0,
    });
    expect(result.startIndex).to.equal(50);
    expect(result.offsetY).to.equal(50 * ROW_HEIGHT);
  });

  it('applies overscan symmetrically on both ends', () => {
    const result = computeVisibleRange({
      scrollTop: ROW_HEIGHT * 50,
      viewportHeight: 220, // 10 rows
      rowHeight: ROW_HEIGHT,
      totalRows: 1000,
      overscan: 5,
    });
    expect(result.startIndex).to.equal(45);
    expect(result.endIndex).to.equal(65); // 50 + 10 + 5
  });

  it('never returns a startIndex below 0, even with overscan near the top', () => {
    const result = computeVisibleRange({
      scrollTop: 0,
      viewportHeight: 220,
      rowHeight: ROW_HEIGHT,
      totalRows: 1000,
      overscan: 5,
    });
    expect(result.startIndex).to.equal(0);
  });

  it('never returns an endIndex beyond totalRows, even with overscan near the bottom', () => {
    const totalRows = 60;
    const result = computeVisibleRange({
      scrollTop: (totalRows - 10) * ROW_HEIGHT, // scrolled to the very end
      viewportHeight: 220,
      rowHeight: ROW_HEIGHT,
      totalRows,
      overscan: 5,
    });
    expect(result.endIndex).to.equal(totalRows);
  });

  it('when totalRows fits in less than one viewport, still returns a sane bounded range', () => {
    const result = computeVisibleRange({
      scrollTop: 0,
      viewportHeight: 220,
      rowHeight: ROW_HEIGHT,
      totalRows: 3,
      overscan: 5,
    });
    expect(result.startIndex).to.equal(0);
    expect(result.endIndex).to.equal(3);
    expect(result.totalHeight).to.equal(3 * ROW_HEIGHT);
  });

  it('with zero rows, returns an empty, zero-height range without throwing', () => {
    const result = computeVisibleRange({
      scrollTop: 0,
      viewportHeight: 220,
      rowHeight: ROW_HEIGHT,
      totalRows: 0,
      overscan: 5,
    });
    expect(result).to.deep.equal({ startIndex: 0, endIndex: 0, offsetY: 0, totalHeight: 0 });
  });
});

describe('scrollOffsetForIndex', () => {
  it('leaves scrollTop unchanged when the row is already fully visible', () => {
    const result = scrollOffsetForIndex({
      index: 5,
      rowHeight: ROW_HEIGHT,
      viewportHeight: 220, // rows 0-9 visible at scrollTop 0
      currentScrollTop: 0,
    });
    expect(result).to.equal(0);
  });

  it('scrolls up to align the row with the viewport top when it is above the current view', () => {
    const result = scrollOffsetForIndex({
      index: 2,
      rowHeight: ROW_HEIGHT,
      viewportHeight: 220,
      currentScrollTop: ROW_HEIGHT * 50, // viewing rows ~50-59, row 2 is above
    });
    expect(result).to.equal(2 * ROW_HEIGHT);
  });

  it('scrolls down to align the row with the viewport bottom when it is below the current view', () => {
    const currentScrollTop = 0; // viewing rows 0-9
    const targetIndex = 20; // well below the current window
    const result = scrollOffsetForIndex({
      index: targetIndex,
      rowHeight: ROW_HEIGHT,
      viewportHeight: 220,
      currentScrollTop,
    });
    const expectedTop = (targetIndex + 1) * ROW_HEIGHT - 220;
    expect(result).to.equal(expectedTop);
  });

  it('at the exact boundary (row bottom == viewport bottom), leaves scrollTop unchanged', () => {
    // viewportHeight 220 = 10 rows; row 9's bottom is exactly at 220.
    const result = scrollOffsetForIndex({
      index: 9,
      rowHeight: ROW_HEIGHT,
      viewportHeight: 220,
      currentScrollTop: 0,
    });
    expect(result).to.equal(0);
  });
});
