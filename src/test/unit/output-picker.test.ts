import { expect } from 'chai';
import {
  defaultFilenameForFormat,
  saveFiltersForFormat,
  languageIdForFormat,
} from '../../ui/output-picker';

describe('defaultFilenameForFormat', () => {
  it('returns handoff.xml for xml', () => {
    expect(defaultFilenameForFormat('xml')).to.equal('handoff.xml');
  });

  it('returns handoff.md for markdown', () => {
    expect(defaultFilenameForFormat('markdown')).to.equal('handoff.md');
  });

  it('returns handoff.txt for plain', () => {
    expect(defaultFilenameForFormat('plain')).to.equal('handoff.txt');
  });
});

describe('saveFiltersForFormat', () => {
  it('xml filters include xml extension', () => {
    expect(saveFiltersForFormat('xml')).to.have.property('XML files').that.includes('xml');
  });

  it('markdown filters include md and markdown', () => {
    const f = saveFiltersForFormat('markdown');
    expect(f['Markdown']).to.deep.equal(['md', 'markdown']);
  });

  it('plain filters include txt', () => {
    const f = saveFiltersForFormat('plain');
    expect(f['Text files']).to.deep.equal(['txt']);
  });

  it('all formats include an All files fallback', () => {
    for (const fmt of ['xml', 'markdown', 'plain'] as const) {
      expect(saveFiltersForFormat(fmt)).to.have.property('All files');
    }
  });
});

describe('languageIdForFormat', () => {
  it('maps formats to VS Code language IDs', () => {
    expect(languageIdForFormat('xml')).to.equal('xml');
    expect(languageIdForFormat('markdown')).to.equal('markdown');
    expect(languageIdForFormat('plain')).to.equal('plaintext');
  });
});
