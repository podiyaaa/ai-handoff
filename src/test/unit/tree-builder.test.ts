import { expect } from 'chai';
import { buildTree, buildTreeForFormat } from '../../core/tree-builder';

describe('buildTree — basic', () => {
  it('returns just the root for empty input', () => {
    const tree = buildTree([]);
    expect(tree).to.equal('root/');
  });

  it('uses a custom root label when provided', () => {
    const tree = buildTree([], { rootLabel: 'my-project' });
    expect(tree).to.equal('my-project/');
  });

  it('renders a single file at root', () => {
    const tree = buildTree(['README.md']);
    expect(tree).to.equal(['root/', '└── README.md'].join('\n'));
  });

  it('renders multiple files at root, sorted (uppercase before lowercase)', () => {
    const tree = buildTree(['index.ts', 'README.md', 'package.json']);
    expect(tree).to.equal(
      [
        'root/',
        '├── README.md',
        '├── index.ts',
        '└── package.json',
      ].join('\n'),
    );
  });
});

describe('buildTree — nested directories', () => {
  it('renders a single file in a subdirectory', () => {
    const tree = buildTree(['src/index.ts']);
    expect(tree).to.equal(
      [
        'root/',
        '└── src/',
        '    └── index.ts',
      ].join('\n'),
    );
  });

  it('groups multiple files under the same directory', () => {
    const tree = buildTree(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(tree).to.equal(
      [
        'root/',
        '└── src/',
        '    ├── a.ts',
        '    ├── b.ts',
        '    └── c.ts',
      ].join('\n'),
    );
  });

  it('renders deeply nested paths', () => {
    const tree = buildTree(['src/auth/handlers/login.ts']);
    expect(tree).to.equal(
      [
        'root/',
        '└── src/',
        '    └── auth/',
        '        └── handlers/',
        '            └── login.ts',
      ].join('\n'),
    );
  });

  it('mixes files and directories with correct branch characters', () => {
    const tree = buildTree([
      'README.md',
      'src/index.ts',
      'src/auth/login.ts',
      'src/utils/helper.ts',
    ]);
    expect(tree).to.equal(
      [
        'root/',
        '├── src/',
        '│   ├── auth/',
        '│   │   └── login.ts',
        '│   ├── utils/',
        '│   │   └── helper.ts',
        '│   └── index.ts',
        '└── README.md',
      ].join('\n'),
    );
  });
});

describe('buildTree — sorting', () => {
  it('lists directories before files at the same level', () => {
    const tree = buildTree(['z-file.ts', 'a-folder/b.ts']);
    expect(tree).to.equal(
      [
        'root/',
        '├── a-folder/',
        '│   └── b.ts',
        '└── z-file.ts',
      ].join('\n'),
    );
  });

  it('sorts directories alphabetically', () => {
    const tree = buildTree(['zeta/x.ts', 'alpha/x.ts', 'mu/x.ts']);
    const lines = tree.split('\n');
    expect(lines[1]).to.match(/alpha\/$/);
    expect(lines[3]).to.match(/mu\/$/);
    expect(lines[5]).to.match(/zeta\/$/);
  });

  it('sorts files alphabetically within a directory', () => {
    const tree = buildTree(['src/zebra.ts', 'src/apple.ts', 'src/mango.ts']);
    expect(tree).to.equal(
      [
        'root/',
        '└── src/',
        '    ├── apple.ts',
        '    ├── mango.ts',
        '    └── zebra.ts',
      ].join('\n'),
    );
  });
});

describe('buildTree — path normalization', () => {
  it('treats windows separators the same as POSIX', () => {
    const tree = buildTree(['src\\auth\\login.ts']);
    expect(tree).to.equal(
      [
        'root/',
        '└── src/',
        '    └── auth/',
        '        └── login.ts',
      ].join('\n'),
    );
  });

  it('strips leading slashes', () => {
    const tree = buildTree(['/src/index.ts']);
    expect(tree).to.equal(
      [
        'root/',
        '└── src/',
        '    └── index.ts',
      ].join('\n'),
    );
  });

  it('strips trailing slashes', () => {
    const tree = buildTree(['src/index.ts/']);
    expect(tree).to.equal(
      [
        'root/',
        '└── src/',
        '    └── index.ts',
      ].join('\n'),
    );
  });

  it('deduplicates repeated paths', () => {
    const tree = buildTree(['src/index.ts', 'src/index.ts', 'src/index.ts']);
    expect(tree).to.equal(
      [
        'root/',
        '└── src/',
        '    └── index.ts',
      ].join('\n'),
    );
  });

  it('skips empty path entries', () => {
    const tree = buildTree(['', '/', 'src/index.ts']);
    expect(tree).to.equal(
      [
        'root/',
        '└── src/',
        '    └── index.ts',
      ].join('\n'),
    );
  });
});

describe('buildTree — complex realistic scenarios', () => {
  it('handles a realistic monorepo selection', () => {
    const tree = buildTree([
      'packages/api/src/server.ts',
      'packages/api/src/routes/users.ts',
      'packages/api/package.json',
      'packages/web/src/App.tsx',
      'packages/web/src/components/Header.tsx',
      'packages/web/package.json',
      'package.json',
      'README.md',
    ]);
    const lines = tree.split('\n');
    // Just sanity-check key features rather than the entire long string.
    expect(lines[0]).to.equal('root/');
    expect(tree).to.include('packages/');
    expect(tree).to.include('api/');
    expect(tree).to.include('web/');
    expect(tree).to.include('routes/');
    expect(tree).to.include('components/');
    // Root-level package.json and README.md should appear after the packages/ dir
    const packagesIdx = lines.findIndex((l) => l.includes('packages/'));
    const rootPackageIdx = lines.findIndex(
      (l, i) => i > packagesIdx && /└──\s*package\.json/.test(l),
    );
    expect(rootPackageIdx).to.be.greaterThan(packagesIdx);
  });

  it('correctly uses ├── for non-last and └── for last children', () => {
    const tree = buildTree(['a/x.ts', 'b/x.ts', 'c/x.ts']);
    const lines = tree.split('\n');
    expect(lines[1].startsWith('├── a/')).to.be.true;
    expect(lines[3].startsWith('├── b/')).to.be.true;
    expect(lines[5].startsWith('└── c/')).to.be.true;
  });

  it('correctly continues │ for ancestors of non-last children', () => {
    const tree = buildTree(['a/x.ts', 'b/x.ts']);
    // After 'a/' (which is not last), descending into it should use '│   '
    const lines = tree.split('\n');
    expect(lines[2]).to.equal('│   └── x.ts');
    // After 'b/' (which is last), descending should use '    '
    expect(lines[4]).to.equal('    └── x.ts');
  });
});

describe('buildTreeForFormat', () => {
  const paths = ['src/index.ts'];

  it('wraps in <directory_structure> for XML', () => {
    const out = buildTreeForFormat(paths, 'xml');
    expect(out).to.match(/^<directory_structure>\n/);
    expect(out).to.match(/\n<\/directory_structure>$/);
    expect(out).to.include('└── index.ts');
  });

  it('wraps in markdown heading + code fence for markdown', () => {
    const out = buildTreeForFormat(paths, 'markdown');
    expect(out).to.match(/^## Directory structure\n\n```\n/);
    expect(out).to.match(/\n```$/);
    expect(out).to.include('└── index.ts');
  });

  it('uses simple prefix for plain text', () => {
    const out = buildTreeForFormat(paths, 'plain');
    expect(out).to.match(/^Directory structure:\n/);
    expect(out).to.include('└── index.ts');
    expect(out).to.not.include('<directory_structure>');
    expect(out).to.not.include('```');
  });

  it('honors a custom root label across all formats', () => {
    const xml = buildTreeForFormat(paths, 'xml', { rootLabel: 'my-app' });
    expect(xml).to.include('my-app/');
    const md = buildTreeForFormat(paths, 'markdown', { rootLabel: 'my-app' });
    expect(md).to.include('my-app/');
    const plain = buildTreeForFormat(paths, 'plain', { rootLabel: 'my-app' });
    expect(plain).to.include('my-app/');
  });
});
