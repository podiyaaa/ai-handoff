import { expect } from 'chai';
import { estimateTokens, formatTokenCount } from '../../core/token-estimator';

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).to.equal(0);
  });

  it('uses chars/4 by default (ceiling)', () => {
    expect(estimateTokens('hello')).to.equal(2); // ceil(5/4)
    expect(estimateTokens('hello world')).to.equal(3); // ceil(11/4)
    expect(estimateTokens('xxxx')).to.equal(1); // ceil(4/4)
    expect(estimateTokens('xxxxx')).to.equal(2); // ceil(5/4)
  });

  it('respects custom ratio', () => {
    expect(estimateTokens('hello world', 2)).to.equal(6); // ceil(11/2)
    expect(estimateTokens('hello world', 11)).to.equal(1); // ceil(11/11)
  });

  it('clamps ratio to a minimum of 1 (no division by zero)', () => {
    expect(estimateTokens('hello', 0)).to.equal(5);
    expect(estimateTokens('hello', -5)).to.equal(5);
  });

  it('handles long input', () => {
    const long = 'x'.repeat(100_000);
    expect(estimateTokens(long)).to.equal(25_000);
  });
});

describe('formatTokenCount', () => {
  it('renders small counts as-is', () => {
    expect(formatTokenCount(0)).to.equal('0');
    expect(formatTokenCount(42)).to.equal('42');
    expect(formatTokenCount(999)).to.equal('999');
  });

  it('renders thousands with one decimal', () => {
    expect(formatTokenCount(1000)).to.equal('1.0k');
    expect(formatTokenCount(1024)).to.equal('1.0k');
    expect(formatTokenCount(8400)).to.equal('8.4k');
    expect(formatTokenCount(99_900)).to.equal('99.9k');
  });

  it('renders ≥100k with no decimal', () => {
    expect(formatTokenCount(100_000)).to.equal('100k');
    expect(formatTokenCount(125_000)).to.equal('125k');
    expect(formatTokenCount(999_499)).to.equal('999k');
  });

  it('renders millions with one decimal', () => {
    expect(formatTokenCount(1_000_000)).to.equal('1.0M');
    expect(formatTokenCount(1_240_000)).to.equal('1.2M');
    expect(formatTokenCount(9_500_000)).to.equal('9.5M');
  });
});
