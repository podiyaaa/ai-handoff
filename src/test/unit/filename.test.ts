import { expect } from 'chai';
import { sanitizeFilenameSegment } from '../../core/filename';

describe('sanitizeFilenameSegment', () => {
  it('leaves a simple name unchanged', () => {
    expect(sanitizeFilenameSegment('ai-handoff')).to.equal('ai-handoff');
  });

  it('replaces slashes in a scoped package name', () => {
    expect(sanitizeFilenameSegment('@org/app')).to.equal('@org-app');
  });

  it('replaces filesystem-unsafe characters', () => {
    expect(sanitizeFilenameSegment('a:b*c?d"e<f>g|h')).to.equal('a-b-c-d-e-f-g-h');
  });

  it('collapses whitespace to a dash', () => {
    expect(sanitizeFilenameSegment('my   project name')).to.equal('my-project-name');
  });

  it('trims leading and trailing dashes', () => {
    expect(sanitizeFilenameSegment('/leading-and-trailing/')).to.equal('leading-and-trailing');
  });

  it('returns an empty string when nothing meaningful remains', () => {
    expect(sanitizeFilenameSegment('///')).to.equal('');
  });
});
