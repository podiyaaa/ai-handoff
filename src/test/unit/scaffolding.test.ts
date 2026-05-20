import { expect } from 'chai';
import type { OutputFormat } from '../../core/types';

describe('scaffolding sanity check', () => {
  it('types are importable', () => {
    const fmt: OutputFormat = 'xml';
    expect(fmt).to.equal('xml');
  });

  it('math still works', () => {
    expect(1 + 1).to.equal(2);
  });
});
