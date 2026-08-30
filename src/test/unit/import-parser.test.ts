import { expect } from 'chai';
import { extractImportSpecifiers, isJsOrTsFile, isRelativeSpecifier, JS_TS_EXTENSIONS } from '../../core/import-parser';

describe('isJsOrTsFile', () => {
  it('recognizes every extension in JS_TS_EXTENSIONS, case-insensitively', () => {
    for (const ext of JS_TS_EXTENSIONS) {
      expect(isJsOrTsFile(`src/foo${ext}`)).to.be.true;
      expect(isJsOrTsFile(`src/foo${ext.toUpperCase()}`)).to.be.true;
    }
  });

  it('rejects non-JS/TS extensions', () => {
    expect(isJsOrTsFile('src/foo.py')).to.be.false;
    expect(isJsOrTsFile('README.md')).to.be.false;
    expect(isJsOrTsFile('src/foo.json')).to.be.false;
  });
});

describe('isRelativeSpecifier', () => {
  it('treats ./ and ../ prefixed specifiers as relative', () => {
    expect(isRelativeSpecifier('./foo')).to.be.true;
    expect(isRelativeSpecifier('../foo/bar')).to.be.true;
  });

  it('treats bare package names and aliases as non-relative', () => {
    expect(isRelativeSpecifier('react')).to.be.false;
    expect(isRelativeSpecifier('@app/button')).to.be.false;
  });

  it('treats an absolute path as non-relative (not ./ or ../)', () => {
    expect(isRelativeSpecifier('/abs/path')).to.be.false;
  });
});

describe('extractImportSpecifiers', () => {
  it('extracts a default import (import ... from)', () => {
    expect(extractImportSpecifiers(`import Foo from './foo';`)).to.deep.equal(['./foo']);
  });

  it('extracts a named import', () => {
    expect(extractImportSpecifiers(`import { a, b } from '../bar';`)).to.deep.equal(['../bar']);
  });

  it('extracts a namespace import of a bare package', () => {
    expect(extractImportSpecifiers(`import * as ns from 'pkg';`)).to.deep.equal(['pkg']);
  });

  it('extracts a multiline named-import list', () => {
    const source = `import {\n  Foo,\n  Bar,\n} from '../multi';`;
    expect(extractImportSpecifiers(source)).to.deep.equal(['../multi']);
  });

  it('extracts an `import type` specifier', () => {
    expect(extractImportSpecifiers(`import type { Foo } from './types';`)).to.deep.equal(['./types']);
  });

  it('extracts a bare side-effect import (no "from")', () => {
    expect(extractImportSpecifiers(`import './side-effect';`)).to.deep.equal(['./side-effect']);
  });

  it('extracts `export ... from` and `export * from`', () => {
    expect(extractImportSpecifiers(`export { x } from './x';`)).to.deep.equal(['./x']);
    expect(extractImportSpecifiers(`export * from './y';`)).to.deep.equal(['./y']);
    expect(extractImportSpecifiers(`export type { Z } from './z';`)).to.deep.equal(['./z']);
  });

  it('extracts a require(...) call', () => {
    expect(extractImportSpecifiers(`const x = require('./z');`)).to.deep.equal(['./z']);
  });

  it('extracts a dynamic import(...) call', () => {
    expect(extractImportSpecifiers(`const y = await import('./dynamic');`)).to.deep.equal(['./dynamic']);
  });

  it('does not confuse a dynamic import() with a bare side-effect import', () => {
    const specifiers = extractImportSpecifiers(`const y = import('./dynamic');`);
    expect(specifiers).to.deep.equal(['./dynamic']);
  });

  it('extracts every specifier from a file with a mix of all four syntaxes', () => {
    const source = [
      `import Foo from './foo';`,
      `import './side-effect';`,
      `export { Bar } from './bar';`,
      `const x = require('./req');`,
      `const y = import('./dyn');`,
      `import ns from 'bare-pkg';`,
    ].join('\n');
    expect(extractImportSpecifiers(source)).to.deep.equal([
      './foo',
      './bar',
      'bare-pkg',
      './side-effect',
      './req',
      './dyn',
    ]);
  });

  it('returns an empty array for source with no imports', () => {
    expect(extractImportSpecifiers('const x = 1;\nfunction f() { return x; }')).to.deep.equal([]);
  });

  it('keeps bare specifiers as candidates rather than filtering them out', () => {
    expect(extractImportSpecifiers(`import Button from '@app/button';`)).to.deep.equal(['@app/button']);
  });
});
