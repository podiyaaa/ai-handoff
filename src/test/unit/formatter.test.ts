import { expect } from 'chai';
import {
  formatHandoff,
  formatStatsForPanel,
  getLanguageForPath,
  applyLineNumbers,
  chooseFence,
  escapeXmlAttr,
  formatDiffSection,
  formatDiffFile,
} from '../../core/formatter';
import type { DiffFileChange, GitDiffResult, IncludedFile, LineRange, SkippedFile } from '../../core/types';

function mkFile(
  relativePath: string,
  content: string | null,
  opts: { isBinary?: boolean; sizeBytes?: number; lineRange?: LineRange } = {},
): IncludedFile {
  return {
    relativePath,
    absolutePath: '/abs/' + relativePath,
    content,
    isBinary: opts.isBinary ?? false,
    sizeBytes: opts.sizeBytes ?? (content?.length ?? 0),
    lineRange: opts.lineRange,
  };
}

describe('getLanguageForPath', () => {
  it('maps common extensions', () => {
    expect(getLanguageForPath('foo.ts')).to.equal('typescript');
    expect(getLanguageForPath('foo.tsx')).to.equal('tsx');
    expect(getLanguageForPath('foo.js')).to.equal('javascript');
    expect(getLanguageForPath('foo.py')).to.equal('python');
    expect(getLanguageForPath('foo.go')).to.equal('go');
    expect(getLanguageForPath('foo.rs')).to.equal('rust');
  });

  it('is case-insensitive on extension', () => {
    expect(getLanguageForPath('FOO.TS')).to.equal('typescript');
    expect(getLanguageForPath('Foo.JS')).to.equal('javascript');
  });

  it('handles paths with directories', () => {
    expect(getLanguageForPath('src/foo.ts')).to.equal('typescript');
    expect(getLanguageForPath('a/b/c.py')).to.equal('python');
  });

  it('returns empty for unknown extension', () => {
    expect(getLanguageForPath('foo.zzz')).to.equal('');
  });

  it('returns empty for files without extension', () => {
    expect(getLanguageForPath('README')).to.equal('');
  });

  it('recognises special filenames', () => {
    expect(getLanguageForPath('Dockerfile')).to.equal('dockerfile');
    expect(getLanguageForPath('Makefile')).to.equal('makefile');
    expect(getLanguageForPath('Gemfile')).to.equal('ruby');
    expect(getLanguageForPath('.gitignore')).to.equal('gitignore');
  });

  it('recognises special filenames inside directories', () => {
    expect(getLanguageForPath('docker/Dockerfile')).to.equal('dockerfile');
    expect(getLanguageForPath('src/.gitignore')).to.equal('gitignore');
  });
});

describe('applyLineNumbers', () => {
  it('numbers a single line', () => {
    expect(applyLineNumbers('hello')).to.equal('1  hello');
  });

  it('numbers multiple lines', () => {
    expect(applyLineNumbers('a\nb\nc')).to.equal('1  a\n2  b\n3  c');
  });

  it('right-aligns numbers when there are 10+ lines', () => {
    const input = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    const out = applyLineNumbers(input).split('\n');
    expect(out[0]).to.equal(' 1  line1');
    expect(out[9]).to.equal('10  line10');
  });

  it('right-aligns numbers for 100+ lines', () => {
    const input = Array.from({ length: 100 }, () => 'x').join('\n');
    const out = applyLineNumbers(input).split('\n');
    expect(out[0].startsWith('  1  ')).to.be.true;
    expect(out[99].startsWith('100  ')).to.be.true;
  });

  it('numbers from a custom start line, for a sliced excerpt of a larger file', () => {
    expect(applyLineNumbers('a\nb\nc', 10)).to.equal('10  a\n11  b\n12  c');
  });

  it('right-aligns against the largest number reached, not the line count', () => {
    // 3 lines starting at 98 reaches 100 — width should be 3, not 1.
    const out = applyLineNumbers('a\nb\nc', 98).split('\n');
    expect(out[0]).to.equal(' 98  a');
    expect(out[2]).to.equal('100  c');
  });
});

describe('formatStatsForPanel', () => {
  it('adds formatted size and token strings alongside the raw stats', () => {
    const out = formatStatsForPanel({
      fileCount: 3,
      totalSizeBytes: 24576,
      estimatedTokens: 1500,
      diffFileCount: 0,
    });
    expect(out.fileCount).to.equal(3);
    expect(out.sizeFormatted).to.equal('24.0 KB');
    expect(out.tokensFormatted).to.equal('1.5k');
  });
});

describe('chooseFence', () => {
  it('returns ``` when content has no fences', () => {
    expect(chooseFence('hello world')).to.equal('```');
  });

  it('returns longer fence when content has ```', () => {
    expect(chooseFence('here is a fence:\n```\nstuff\n```')).to.equal('````');
  });

  it('returns even longer fence when content has ````', () => {
    expect(chooseFence('````\nnested\n````')).to.equal('`````');
  });

  it('ignores backticks shorter than 3', () => {
    expect(chooseFence('` ` ``')).to.equal('```');
  });
});

describe('escapeXmlAttr', () => {
  it('escapes ampersand', () => {
    expect(escapeXmlAttr('foo & bar')).to.equal('foo &amp; bar');
  });

  it('escapes double quote', () => {
    expect(escapeXmlAttr('say "hi"')).to.equal('say &quot;hi&quot;');
  });

  it('escapes less-than', () => {
    expect(escapeXmlAttr('a<b')).to.equal('a&lt;b');
  });

  it('escapes them all in one string', () => {
    expect(escapeXmlAttr('a&b"c<d')).to.equal('a&amp;b&quot;c&lt;d');
  });

  it('escapes ampersand before others', () => {
    // We must escape & first so we don't double-escape the & in &quot;
    expect(escapeXmlAttr('&"<')).to.equal('&amp;&quot;&lt;');
  });
});

describe('formatHandoff — XML format', () => {
  it('formats a single text file', () => {
    const out = formatHandoff(
      [mkFile('src/index.ts', 'const x = 1;')],
      { format: 'xml', includeLineNumbers: false },
    );
    expect(out).to.equal('<file path="src/index.ts">\nconst x = 1;\n</file>');
  });

  it('formats binary file as self-closing tag with size', () => {
    const out = formatHandoff(
      [mkFile('logo.png', null, { isBinary: true, sizeBytes: 24576 })],
      { format: 'xml', includeLineNumbers: false },
    );
    expect(out).to.equal('<file path="logo.png" type="binary" size="24.0KB" />');
  });

  it('escapes special chars in path attribute', () => {
    const out = formatHandoff(
      [mkFile('foo&bar.ts', 'x')],
      { format: 'xml', includeLineNumbers: false },
    );
    expect(out).to.include('path="foo&amp;bar.ts"');
  });

  it('includes line numbers when enabled', () => {
    const out = formatHandoff(
      [mkFile('a.ts', 'a\nb')],
      { format: 'xml', includeLineNumbers: true },
    );
    expect(out).to.include('1  a');
    expect(out).to.include('2  b');
  });

  it('adds a lines="" attribute for a line-ranged excerpt', () => {
    const out = formatHandoff(
      [mkFile('a.ts', 'const x = 1;', { lineRange: { start: 10, end: 12 } })],
      { format: 'xml', includeLineNumbers: false },
    );
    expect(out).to.equal('<file path="a.ts" lines="10-12">\nconst x = 1;\n</file>');
  });

  it('numbers a line-ranged excerpt starting from its original line number, not 1', () => {
    const out = formatHandoff(
      [mkFile('a.ts', 'a\nb\nc', { lineRange: { start: 10, end: 12 } })],
      { format: 'xml', includeLineNumbers: true },
    );
    expect(out).to.include('10  a');
    expect(out).to.include('11  b');
    expect(out).to.include('12  c');
  });

  it('sorts multiple files by path', () => {
    const out = formatHandoff(
      [
        mkFile('z.ts', 'z'),
        mkFile('a.ts', 'a'),
        mkFile('m.ts', 'm'),
      ],
      { format: 'xml', includeLineNumbers: false },
    );
    const zIdx = out.indexOf('"z.ts"');
    const aIdx = out.indexOf('"a.ts"');
    const mIdx = out.indexOf('"m.ts"');
    expect(aIdx).to.be.lessThan(mIdx);
    expect(mIdx).to.be.lessThan(zIdx);
  });

  it('includes tree section when provided', () => {
    const out = formatHandoff(
      [mkFile('a.ts', 'a')],
      {
        format: 'xml',
        includeLineNumbers: false,
        treeSection: '<directory_structure>\nroot/\n└── a.ts\n</directory_structure>',
      },
    );
    expect(out).to.match(/^<directory_structure>/);
    expect(out).to.include('<file path="a.ts"');
    expect(out.indexOf('<directory_structure>')).to.be.lessThan(out.indexOf('<file'));
  });

  it('includes custom instructions when provided', () => {
    const out = formatHandoff(
      [mkFile('a.ts', 'a')],
      {
        format: 'xml',
        includeLineNumbers: false,
        customInstructions: 'Review this for memory leaks.',
      },
    );
    expect(out).to.match(/^<instructions>/);
    expect(out).to.include('Review this for memory leaks.');
    expect(out).to.include('</instructions>');
  });

  it('omits instructions section when empty/whitespace', () => {
    const out = formatHandoff(
      [mkFile('a.ts', 'a')],
      {
        format: 'xml',
        includeLineNumbers: false,
        customInstructions: '   \n   ',
      },
    );
    expect(out).to.not.include('<instructions>');
  });

  it('includes skipped files section when any provided', () => {
    const skipped: SkippedFile[] = [
      {
        relativePath: 'node_modules/foo.js',
        absolutePath: '/abs/node_modules/foo.js',
        reason: 'smart-filter',
        sizeBytes: 100,
      },
      {
        relativePath: 'huge.json',
        absolutePath: '/abs/huge.json',
        reason: 'too-large',
        detail: '5.0 MB > 1024 KB limit',
        sizeBytes: 5_000_000,
      },
    ];
    const out = formatHandoff(
      [mkFile('a.ts', 'a')],
      { format: 'xml', includeLineNumbers: false, skippedFiles: skipped },
    );
    expect(out).to.include('<skipped_files count="2">');
    expect(out).to.include('Smart filter');
    expect(out).to.include('node_modules/foo.js');
    expect(out).to.include('huge.json');
    expect(out).to.include('5.0 MB');
  });
});

describe('formatHandoff — Markdown format', () => {
  it('uses heading + code fence with language', () => {
    const out = formatHandoff(
      [mkFile('src/index.ts', 'const x = 1;')],
      { format: 'markdown', includeLineNumbers: false },
    );
    expect(out).to.equal(
      '### `src/index.ts`\n\n```typescript\nconst x = 1;\n```',
    );
  });

  it('uses no language for unknown extensions', () => {
    const out = formatHandoff(
      [mkFile('mystery.zzz', 'data')],
      { format: 'markdown', includeLineNumbers: false },
    );
    expect(out).to.include('```\ndata\n```');
  });

  it('uses longer fence when content contains ```', () => {
    const out = formatHandoff(
      [mkFile('readme.md', 'A code block:\n```\nhello\n```')],
      { format: 'markdown', includeLineNumbers: false },
    );
    expect(out).to.include('````markdown\n');
    expect(out).to.match(/````$/);
  });

  it('marks binary files appropriately', () => {
    const out = formatHandoff(
      [mkFile('logo.png', null, { isBinary: true, sizeBytes: 24576 })],
      { format: 'markdown', includeLineNumbers: false },
    );
    expect(out).to.include('### `logo.png`');
    expect(out).to.include('_Binary file (24.0 KB) — content omitted._');
  });

  it('notes the line range in the heading for a line-ranged excerpt', () => {
    const out = formatHandoff(
      [mkFile('src/index.ts', 'const x = 1;', { lineRange: { start: 10, end: 12 } })],
      { format: 'markdown', includeLineNumbers: false },
    );
    expect(out).to.include('### `src/index.ts` (lines 10-12)');
  });

  it('renders skipped files section with heading', () => {
    const skipped: SkippedFile[] = [
      {
        relativePath: 'app.log',
        absolutePath: '/abs/app.log',
        reason: 'gitignore',
        sizeBytes: 100,
      },
    ];
    const out = formatHandoff(
      [mkFile('a.ts', 'a')],
      { format: 'markdown', includeLineNumbers: false, skippedFiles: skipped },
    );
    expect(out).to.include('## Skipped files (1)');
  });

  it('renders instructions with heading', () => {
    const out = formatHandoff(
      [mkFile('a.ts', 'a')],
      {
        format: 'markdown',
        includeLineNumbers: false,
        customInstructions: 'Find the bug.',
      },
    );
    expect(out).to.match(/^## Instructions\n\nFind the bug\./);
  });
});

describe('formatHandoff — plain format', () => {
  it('uses simple --- separators', () => {
    const out = formatHandoff(
      [mkFile('src/index.ts', 'const x = 1;')],
      { format: 'plain', includeLineNumbers: false },
    );
    expect(out).to.equal('--- src/index.ts ---\nconst x = 1;');
  });

  it('renders binary placeholder', () => {
    const out = formatHandoff(
      [mkFile('logo.png', null, { isBinary: true, sizeBytes: 1024 })],
      { format: 'plain', includeLineNumbers: false },
    );
    expect(out).to.include('--- logo.png ---');
    expect(out).to.include('[binary file, 1.0 KB, content omitted]');
  });

  it('notes the line range in the separator for a line-ranged excerpt', () => {
    const out = formatHandoff(
      [mkFile('src/index.ts', 'const x = 1;', { lineRange: { start: 10, end: 12 } })],
      { format: 'plain', includeLineNumbers: false },
    );
    expect(out).to.equal('--- src/index.ts (lines 10-12) ---\nconst x = 1;');
  });

  it('renders instructions plainly', () => {
    const out = formatHandoff(
      [mkFile('a.ts', 'a')],
      {
        format: 'plain',
        includeLineNumbers: false,
        customInstructions: 'Find the bug.',
      },
    );
    expect(out).to.match(/^Instructions:\nFind the bug\./);
  });
});

describe('formatHandoff — full handoff structure', () => {
  it('orders sections: instructions, tree, files, skipped', () => {
    const out = formatHandoff(
      [mkFile('src/a.ts', 'a')],
      {
        format: 'xml',
        includeLineNumbers: false,
        customInstructions: 'Review.',
        treeSection: '<directory_structure>\nroot/\n└── src/a.ts\n</directory_structure>',
        skippedFiles: [
          {
            relativePath: 'big.json',
            absolutePath: '/abs/big.json',
            reason: 'too-large',
            sizeBytes: 5_000_000,
          },
        ],
      },
    );
    const idxInstructions = out.indexOf('<instructions>');
    const idxTree = out.indexOf('<directory_structure>');
    const idxFile = out.indexOf('<file path="src/a.ts"');
    const idxSkipped = out.indexOf('<skipped_files');
    expect(idxInstructions).to.be.lessThan(idxTree);
    expect(idxTree).to.be.lessThan(idxFile);
    expect(idxFile).to.be.lessThan(idxSkipped);
  });

  it('separates sections with a blank line', () => {
    const out = formatHandoff(
      [mkFile('a.ts', 'a'), mkFile('b.ts', 'b')],
      { format: 'xml', includeLineNumbers: false },
    );
    // Between two files there should be a blank line (i.e. \n\n)
    expect(out).to.match(/<\/file>\n\n<file/);
  });

  it('handles empty input gracefully', () => {
    const out = formatHandoff([], { format: 'xml', includeLineNumbers: false });
    expect(out).to.equal('');
  });
});

function mkDiffFile(overrides: Partial<DiffFileChange> = {}): DiffFileChange {
  return {
    relativePath: 'src/a.ts',
    changeType: 'modified',
    patch: '@@ -1 +1 @@\n-old\n+new',
    isBinary: false,
    staged: false,
    repoLabel: 'my-repo',
    repoRoot: '/repo',
    ...overrides,
  };
}

function mkDiffResult(files: DiffFileChange[], overrides: Partial<GitDiffResult> = {}): GitDiffResult {
  return {
    scope: 'working',
    files,
    reposWithNoGit: [],
    ...overrides,
  };
}

describe('formatDiffFile', () => {
  it('renders a modified file in each format', () => {
    const file = mkDiffFile();
    expect(formatDiffFile(file, 'xml')).to.equal(
      '<diff_file path="src/a.ts" change="modified">\n@@ -1 +1 @@\n-old\n+new\n</diff_file>',
    );
    expect(formatDiffFile(file, 'markdown')).to.include('##### `src/a.ts` — modified');
    expect(formatDiffFile(file, 'markdown')).to.include('```diff');
    expect(formatDiffFile(file, 'plain')).to.equal(
      '--- src/a.ts [modified] ---\n@@ -1 +1 @@\n-old\n+new',
    );
  });

  it('includes the old path for a rename', () => {
    const file = mkDiffFile({ changeType: 'renamed', oldPath: 'src/old.ts' });
    expect(formatDiffFile(file, 'xml')).to.include('from="src/old.ts"');
    expect(formatDiffFile(file, 'markdown')).to.include('(renamed from `src/old.ts`)');
    expect(formatDiffFile(file, 'plain')).to.include('(renamed from src/old.ts)');
  });

  it('marks binary diffs', () => {
    const file = mkDiffFile({ isBinary: true, patch: 'Binary files a/img.png and b/img.png differ' });
    expect(formatDiffFile(file, 'xml')).to.include('binary="true"');
  });
});

describe('formatDiffSection', () => {
  it('returns an empty string when there are no files', () => {
    expect(formatDiffSection(mkDiffResult([]), 'xml')).to.equal('');
  });

  it('returns an empty string when the diff read failed', () => {
    const result = mkDiffResult([mkDiffFile()], { error: 'no-repos-found' });
    expect(formatDiffSection(result, 'xml')).to.equal('');
  });

  it('wraps files in a single-repo section without repo prefixing', () => {
    const result = mkDiffResult([mkDiffFile({ relativePath: 'a.ts' })]);
    const out = formatDiffSection(result, 'xml');
    expect(out).to.include('<git_diff>');
    expect(out).to.include('<diff_file path="a.ts"');
    expect(out).not.to.include('my-repo/a.ts');
  });

  it('splits working vs staged files into separate labeled groups for scope "both"', () => {
    const result = mkDiffResult(
      [
        mkDiffFile({ relativePath: 'unstaged.ts', staged: false }),
        mkDiffFile({ relativePath: 'staged.ts', staged: true }),
      ],
      { scope: 'both' },
    );
    const out = formatDiffSection(result, 'markdown');
    expect(out).to.include('Unstaged changes');
    expect(out).to.include('Staged changes');
    const idxUnstaged = out.indexOf('unstaged.ts');
    const idxStaged = out.indexOf('staged.ts');
    expect(idxUnstaged).to.be.greaterThan(-1);
    expect(idxStaged).to.be.greaterThan(-1);
  });

  it('omits an empty staged/unstaged group', () => {
    const result = mkDiffResult([mkDiffFile({ staged: false })]);
    const out = formatDiffSection(result, 'plain');
    expect(out).to.include('Unstaged changes');
    expect(out).not.to.include('Staged changes');
  });

  it('prefixes paths with the repo label only when multiple repos contributed', () => {
    const result = mkDiffResult([
      mkDiffFile({ relativePath: 'a.ts', repoLabel: 'service-a' }),
      mkDiffFile({ relativePath: 'b.ts', repoLabel: 'service-b' }),
    ]);
    const out = formatDiffSection(result, 'plain');
    expect(out).to.include('service-a/a.ts');
    expect(out).to.include('service-b/b.ts');
    expect(out).to.include('service-a — Unstaged changes');
    expect(out).to.include('service-b — Unstaged changes');
  });
});
