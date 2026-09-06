import { expect } from 'chai';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { findOwningFolder, generateHandoff, readGitignore } from '../../services/handoff-generator';
import type { HandoffOptions, SelectedFile } from '../../core/types';

const baseOpts: HandoffOptions = {
  format: 'xml',
  includeLineNumbers: false,
  maxFileSizeKB: 1024,
  respectGitignore: true,
  smartFilter: true,
  customIgnorePatterns: [],
  binaryHandling: 'placeholder',
  tokenEstimationRatio: 4,
};

async function makeWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-pipeline-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'src', 'auth'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'lodash'), { recursive: true });
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });

  await fs.writeFile(path.join(root, 'README.md'), '# My project');
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const x = 1;');
  await fs.writeFile(
    path.join(root, 'src', 'auth', 'login.ts'),
    'export const login = () => {};',
  );
  await fs.writeFile(
    path.join(root, 'node_modules', 'lodash', 'index.js'),
    'module.exports = {};',
  );
  await fs.writeFile(path.join(root, 'dist', 'bundle.js'), 'minified;');
  await fs.writeFile(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(root, '.gitignore'), '*.log\nsecret/\n');
  await fs.writeFile(path.join(root, 'app.log'), 'log data');
  return root;
}

function sel(root: string, rel: string): SelectedFile {
  return { relativePath: rel, absolutePath: path.join(root, rel) };
}

describe('readGitignore', () => {
  let root: string;
  before(async () => { root = await makeWorkspace(); });
  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('reads .gitignore from workspace root', async () => {
    const content = await readGitignore(root);
    expect(content).to.equal('*.log\nsecret/\n');
  });

  it('returns undefined if .gitignore is missing', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-empty-'));
    expect(await readGitignore(empty)).to.be.undefined;
    await fs.rm(empty, { recursive: true, force: true });
  });
});

describe('generateHandoff — pipeline', () => {
  let root: string;
  before(async () => { root = await makeWorkspace(); });
  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('includes selected source files', async () => {
    const result = await generateHandoff(
      [sel(root, 'src/index.ts'), sel(root, 'README.md')],
      baseOpts,
      root,
    );
    expect(result.included).to.have.lengthOf(2);
    expect(result.skipped).to.have.lengthOf(0);
    expect(result.text).to.include('<file path="README.md">');
    expect(result.text).to.include('<file path="src/index.ts">');
    expect(result.text).to.include('# My project');
    expect(result.text).to.include('export const x = 1;');
  });

  it('skips files matched by smart filter', async () => {
    const result = await generateHandoff(
      [sel(root, 'node_modules/lodash/index.js'), sel(root, 'dist/bundle.js')],
      baseOpts,
      root,
    );
    expect(result.included).to.have.lengthOf(0);
    expect(result.skipped).to.have.lengthOf(2);
    expect(result.skipped.every((s) => s.reason === 'smart-filter')).to.be.true;
  });

  it('skips files matched by .gitignore', async () => {
    // Use a file/pattern that smart-filter doesn't already catch,
    // so we know gitignore (not smart-filter) is the matching layer.
    await fs.writeFile(path.join(root, 'secret-data.json'), '{"key": "value"}');
    // Append a gitignore pattern for this file
    await fs.appendFile(path.join(root, '.gitignore'), '\nsecret-data.json\n');
    const result = await generateHandoff(
      [sel(root, 'secret-data.json')],
      baseOpts,
      root,
    );
    expect(result.included).to.have.lengthOf(0);
    expect(result.skipped).to.have.lengthOf(1);
    expect(result.skipped[0].reason).to.equal('gitignore');
  });

  it('respects size limit', async () => {
    const big = path.join(root, 'big.txt');
    await fs.writeFile(big, 'x'.repeat(2048));
    const result = await generateHandoff(
      [sel(root, 'big.txt')],
      { ...baseOpts, maxFileSizeKB: 1 }, // 1KB limit
      root,
    );
    expect(result.included).to.have.lengthOf(0);
    expect(result.skipped[0].reason).to.equal('too-large');
    await fs.rm(big);
  });

  it('handles binary files as placeholders when binaryHandling="placeholder"', async () => {
    const result = await generateHandoff(
      [sel(root, 'logo.png')],
      baseOpts,
      root,
    );
    expect(result.included).to.have.lengthOf(1);
    expect(result.included[0].isBinary).to.be.true;
    expect(result.included[0].content).to.be.null;
    expect(result.text).to.include('type="binary"');
  });

  it('skips binary files when binaryHandling="skip"', async () => {
    const result = await generateHandoff(
      [sel(root, 'logo.png')],
      { ...baseOpts, binaryHandling: 'skip' },
      root,
    );
    expect(result.included).to.have.lengthOf(0);
    expect(result.skipped).to.have.lengthOf(1);
    expect(result.skipped[0].reason).to.equal('binary-skip');
  });

  it('includes files when explicitly overridden', async () => {
    const result = await generateHandoff(
      [sel(root, 'node_modules/lodash/index.js')],
      { ...baseOpts, overriddenPaths: ['node_modules/lodash/index.js'] },
      root,
    );
    expect(result.included).to.have.lengthOf(1);
    expect(result.included[0].relativePath).to.equal('node_modules/lodash/index.js');
  });

  it('handles a missing file gracefully (skipped with reason)', async () => {
    const result = await generateHandoff(
      [sel(root, 'does-not-exist.ts')],
      baseOpts,
      root,
    );
    expect(result.included).to.have.lengthOf(0);
    expect(result.skipped).to.have.lengthOf(1);
    expect(result.skipped[0].reason).to.equal('unreadable');
  });

  it('produces deterministic order (sorted by path)', async () => {
    const result = await generateHandoff(
      [
        sel(root, 'src/index.ts'),
        sel(root, 'README.md'),
        sel(root, 'src/auth/login.ts'),
      ],
      baseOpts,
      root,
    );
    expect(result.included.map((f) => f.relativePath)).to.deep.equal([
      'README.md',
      'src/auth/login.ts',
      'src/index.ts',
    ]);
  });

  it('reports correct stats', async () => {
    const result = await generateHandoff(
      [sel(root, 'src/index.ts'), sel(root, 'README.md')],
      baseOpts,
      root,
    );
    expect(result.stats.fileCount).to.equal(2);
    expect(result.stats.totalSizeBytes).to.be.greaterThan(0);
    expect(result.stats.estimatedTokens).to.be.greaterThan(0);
  });

  it('uses workspace basename as rootLabel', async () => {
    const result = await generateHandoff([sel(root, 'README.md')], baseOpts, root);
    const expectedLabel = path.basename(root);
    expect(result.text).to.include(`${expectedLabel}/`);
  });

  // ---- Directory-expansion (Bug 2 fix) --------------------------------

  it('expands a directory path to its contained files', async () => {
    // Selecting the 'src' dir should include src/index.ts + src/auth/login.ts
    const result = await generateHandoff(
      [sel(root, 'src')],
      { ...baseOpts, smartFilter: false },
      root,
    );
    const paths = result.included.map((f) => f.relativePath).sort();
    expect(paths).to.deep.equal(['src/auth/login.ts', 'src/index.ts']);
  });

  it('deduplicates when a dir and one of its files are both selected', async () => {
    // Selecting both 'src' and 'src/index.ts' should not produce a duplicate.
    const result = await generateHandoff(
      [sel(root, 'src'), sel(root, 'src/index.ts')],
      { ...baseOpts, smartFilter: false },
      root,
    );
    const paths = result.included.map((f) => f.relativePath);
    const unique = [...new Set(paths)];
    expect(paths).to.deep.equal(unique);
    // And we still have both files
    expect(paths.sort()).to.deep.equal(['src/auth/login.ts', 'src/index.ts']);
  });

  it('mixes directory and individual file selections correctly', async () => {
    // src/auth dir + README.md file — no duplicates, all correct paths
    const result = await generateHandoff(
      [sel(root, 'src/auth'), sel(root, 'README.md')],
      { ...baseOpts, smartFilter: false },
      root,
    );
    const paths = result.included.map((f) => f.relativePath).sort();
    expect(paths).to.deep.equal(['README.md', 'src/auth/login.ts']);
  });

  // ---- Multi-root workspace (Bug 3 fix) --------------------------------

  it('includes files whose absolutePath is outside workspaceRoot (multi-root)', async () => {
    // Simulate a second workspace folder (root-b) that is a sibling of root.
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-root-b-'));
    try {
      await fs.writeFile(path.join(rootB, 'helper.ts'), 'export const h = 2;');

      // SelectedFile has relativePath relative to rootB, absolutePath in rootB.
      // workspaceRoot is still root (folder[0]) — simulating multi-root workspace.
      const result = await generateHandoff(
        [{ relativePath: 'helper.ts', absolutePath: path.join(rootB, 'helper.ts') }],
        { ...baseOpts, smartFilter: false },
        root,
      );
      expect(result.included).to.have.lengthOf(1);
      expect(result.included[0].relativePath).to.equal('helper.ts');
      expect(result.included[0].absolutePath).to.equal(path.join(rootB, 'helper.ts'));
    } finally {
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it('prefixes file paths with folder name when files span multiple workspace folders', async () => {
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-root-b-'));
    try {
      await fs.writeFile(path.join(rootB, 'helper.ts'), 'export const h = 2;');

      const result = await generateHandoff(
        [
          { relativePath: 'src/index.ts', absolutePath: path.join(root, 'src', 'index.ts') },
          { relativePath: 'helper.ts', absolutePath: path.join(rootB, 'helper.ts') },
        ],
        { ...baseOpts, smartFilter: false },
        root,
      );

      const rootName = path.basename(root);
      const rootBName = path.basename(rootB);

      expect(result.included).to.have.lengthOf(2);
      // The generated text should use prefixed paths and a 'workspace' root label.
      expect(result.text).to.include('workspace/');
      expect(result.text).to.include(`${rootName}/src/index.ts`);
      expect(result.text).to.include(`${rootBName}/helper.ts`);
    } finally {
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it('expands a directory from a non-primary workspace folder correctly', async () => {
    // Same setup: rootB is a second workspace folder with its own src/ dir.
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-root-b-'));
    try {
      await fs.mkdir(path.join(rootB, 'src'));
      await fs.writeFile(path.join(rootB, 'src', 'util.ts'), 'export const u = 3;');

      // Select the src/ directory from rootB — relativePath relative to rootB.
      const result = await generateHandoff(
        [{ relativePath: 'src', absolutePath: path.join(rootB, 'src') }],
        { ...baseOpts, smartFilter: false },
        root, // primary workspace root is still root (folder[0])
      );
      // Child paths must be 'src/util.ts', not '../../rootB/src/util.ts'.
      expect(result.included).to.have.lengthOf(1);
      expect(result.included[0].relativePath).to.equal('src/util.ts');
    } finally {
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it('a lineRange on the selection slices the included file down to just those lines', async () => {
    const withRange: SelectedFile = {
      ...sel(root, 'src/auth/login.ts'),
      lineRange: { start: 1, end: 1 },
    };
    const result = await generateHandoff([withRange], baseOpts, root);
    expect(result.included).to.have.lengthOf(1);
    expect(result.included[0].content).to.equal('export const login = () => {};');
    expect(result.included[0].lineRange).to.deep.equal({ start: 1, end: 1 });
    expect(result.text).to.include('<file path="src/auth/login.ts" lines="1-1">');
    // Stats reflect the sliced excerpt, not the whole file on disk.
    expect(result.stats.totalSizeBytes).to.equal(result.included[0].content!.length);
  });
});

// ---- Base64 output ---------------------------------------------------------

describe('generateHandoff — base64Encode', () => {
  let root: string;
  before(async () => { root = await makeWorkspace(); });
  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('base64-encodes result.text while stats reflect the real, non-encoded content', async () => {
    const plain = await generateHandoff(
      [sel(root, 'src/index.ts'), sel(root, 'README.md')],
      baseOpts,
      root,
    );
    const encoded = await generateHandoff(
      [sel(root, 'src/index.ts'), sel(root, 'README.md')],
      { ...baseOpts, base64Encode: true },
      root,
    );

    expect(Buffer.from(encoded.text, 'base64').toString('utf-8')).to.equal(plain.text);
    expect(encoded.stats).to.deep.equal(plain.stats);
  });
});

// ---- Git diff integration ------------------------------------------------

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd });
}

async function makeGitWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-diff-ws-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  return root;
}

describe('generateHandoff — git diff', () => {
  it('attaches diff results alongside selected files when gitDiff is enabled', async () => {
    const root = await makeGitWorkspace();
    try {
      await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 2;\n');
      const result = await generateHandoff(
        [sel(root, 'a.ts')],
        { ...baseOpts, gitDiff: { enabled: true, scope: 'working' } },
        root,
      );
      expect(result.included).to.have.lengthOf(1);
      expect(result.diff?.files).to.have.lengthOf(1);
      expect(result.diff?.files[0].relativePath).to.equal('a.ts');
      expect(result.text).to.include('<git_diff>');
      expect(result.stats.diffFileCount).to.equal(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('produces no diff content when no files are selected', async () => {
    const root = await makeGitWorkspace();
    try {
      await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 3;\n');
      const result = await generateHandoff(
        [],
        { ...baseOpts, gitDiff: { enabled: true, scope: 'working' } },
        root,
      );
      expect(result.included).to.have.lengthOf(0);
      expect(result.diff?.files).to.have.lengthOf(0);
      expect(result.text).to.not.include('<git_diff>');
      expect(result.stats.diffFileCount).to.equal(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('scopes the diff to only the selected files, excluding other changed files', async () => {
    const root = await makeGitWorkspace();
    try {
      await fs.writeFile(path.join(root, 'b.ts'), 'export const b = 1;\n');
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '-m', 'add b']);
      await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 5;\n');
      await fs.writeFile(path.join(root, 'b.ts'), 'export const b = 2;\n');

      const result = await generateHandoff(
        [sel(root, 'a.ts')],
        { ...baseOpts, gitDiff: { enabled: true, scope: 'working' } },
        root,
      );
      expect(result.diff?.files).to.have.lengthOf(1);
      expect(result.diff?.files[0].relativePath).to.equal('a.ts');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not populate diff when gitDiff is not enabled', async () => {
    const root = await makeGitWorkspace();
    try {
      await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 4;\n');
      const result = await generateHandoff([sel(root, 'a.ts')], baseOpts, root);
      expect(result.diff).to.be.undefined;
      expect(result.stats.diffFileCount).to.equal(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('collects diffs across multiple workspace folders when provided', async () => {
    const rootA = await makeGitWorkspace();
    const rootB = await makeGitWorkspace();
    try {
      await fs.writeFile(path.join(rootA, 'a.ts'), 'export const a = 9;\n');
      await fs.writeFile(path.join(rootB, 'a.ts'), 'export const a = 10;\n');

      const result = await generateHandoff(
        [
          { relativePath: `${path.basename(rootA)}/a.ts`, absolutePath: path.join(rootA, 'a.ts') },
          { relativePath: `${path.basename(rootB)}/a.ts`, absolutePath: path.join(rootB, 'a.ts') },
        ],
        { ...baseOpts, gitDiff: { enabled: true, scope: 'working' } },
        rootA,
        [
          { name: path.basename(rootA), path: rootA },
          { name: path.basename(rootB), path: rootB },
        ],
      );
      expect(result.diff?.files).to.have.lengthOf(2);
      const labels = result.diff?.files.map((f) => f.repoLabel).sort();
      expect(labels).to.deep.equal([path.basename(rootA), path.basename(rootB)].sort());
    } finally {
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });
});

describe('findOwningFolder', () => {
  it('matches a file exactly inside a folder', () => {
    const folders = [{ name: 'a', path: '/root/a' }];
    expect(findOwningFolder('/root/a/src/index.ts', folders)).to.deep.equal(folders[0]);
  });

  it('returns undefined when no folder owns the path', () => {
    const folders = [{ name: 'a', path: '/root/a' }];
    expect(findOwningFolder('/root/b/index.ts', folders)).to.be.undefined;
  });

  it('does not match a sibling folder that merely shares a path prefix as a string', () => {
    // '/root/app' is not an ancestor of '/root/app-other/x.ts' even though the
    // string 'app' is a prefix — path.relative()-based containment must not
    // be fooled by this (a naive startsWith() check would be).
    const folders = [{ name: 'app', path: '/root/app' }];
    expect(findOwningFolder('/root/app-other/x.ts', folders)).to.be.undefined;
  });

  it('distinguishes two sibling folders sharing the same parent directory', () => {
    // This is exactly the case that broke the old relativePath-segment-counting
    // inferFolderRoot(): two real, distinct folders under one common parent.
    const folders = [
      { name: 'project-a', path: '/workspace/project-a' },
      { name: 'project-b', path: '/workspace/project-b' },
    ];
    expect(findOwningFolder('/workspace/project-a/src/x.ts', folders)).to.deep.equal(folders[0]);
    expect(findOwningFolder('/workspace/project-b/src/y.ts', folders)).to.deep.equal(folders[1]);
  });

  it('picks the longest-prefix (most specific) match when folders are nested', () => {
    const folders = [
      { name: 'outer', path: '/root' },
      { name: 'inner', path: '/root/nested' },
    ];
    expect(findOwningFolder('/root/nested/x.ts', folders)).to.deep.equal(folders[1]);
    expect(findOwningFolder('/root/other/x.ts', folders)).to.deep.equal(folders[0]);
  });

  it('matches a path equal to the folder root itself', () => {
    const folders = [{ name: 'a', path: '/root/a' }];
    expect(findOwningFolder('/root/a', folders)).to.deep.equal(folders[0]);
  });
});

describe('generateHandoff — accurateMultiRootPaths (flag)', () => {
  let root: string;
  before(async () => { root = await makeWorkspace(); });
  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('flag off (default): root label is folder 0\'s name even when the whole selection is from a different folder — current behavior, unchanged', async () => {
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-rootb-flagoff-'));
    try {
      await fs.writeFile(path.join(rootB, 'helper.ts'), 'export const h = 2;');
      const folders = [
        { name: path.basename(root), path: root },
        { name: path.basename(rootB), path: rootB },
      ];
      const result = await generateHandoff(
        [{ relativePath: 'helper.ts', absolutePath: path.join(rootB, 'helper.ts') }],
        { ...baseOpts, smartFilter: false },
        root,
        folders,
      );
      expect(result.text).to.include(`${path.basename(root)}/`);
      expect(result.text).to.not.include(`${path.basename(rootB)}/`);
    } finally {
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it('flag on: root label uses the file\'s actual owning folder, not folder 0', async () => {
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-rootb-label-'));
    try {
      await fs.writeFile(path.join(rootB, 'helper.ts'), 'export const h = 2;');
      const folders = [
        { name: path.basename(root), path: root },
        { name: path.basename(rootB), path: rootB },
      ];
      const result = await generateHandoff(
        [{ relativePath: 'helper.ts', absolutePath: path.join(rootB, 'helper.ts') }],
        { ...baseOpts, smartFilter: false, accurateMultiRootPaths: true },
        root,
        folders,
      );
      expect(result.included).to.have.lengthOf(1);
      expect(result.text).to.include(`${path.basename(rootB)}/`);
      expect(result.text).to.not.include(`${path.basename(root)}/`);
    } finally {
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it('flag on: applies the selected file\'s OWN folder .gitignore, not folder 0\'s', async () => {
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-rootb-gitignore-'));
    try {
      // root's own .gitignore (from makeWorkspace) has no rule for secret.ts —
      // only rootB's does. If the fix works, secret.ts is skipped; if it
      // silently fell back to root's .gitignore, it would wrongly be included.
      await fs.writeFile(path.join(rootB, '.gitignore'), 'secret.ts\n');
      await fs.writeFile(path.join(rootB, 'secret.ts'), 'export const s = 1;');
      await fs.writeFile(path.join(rootB, 'ok.ts'), 'export const ok = 1;');
      const folders = [
        { name: path.basename(root), path: root },
        { name: path.basename(rootB), path: rootB },
      ];
      const selection = [
        { relativePath: 'secret.ts', absolutePath: path.join(rootB, 'secret.ts') },
        { relativePath: 'ok.ts', absolutePath: path.join(rootB, 'ok.ts') },
      ];

      const accurate = await generateHandoff(
        selection,
        { ...baseOpts, smartFilter: false, accurateMultiRootPaths: true },
        root,
        folders,
      );
      expect(accurate.included.map((f) => f.relativePath).sort()).to.deep.equal(['ok.ts']);
      expect(
        accurate.skipped.some((f) => f.relativePath === 'secret.ts' && f.reason === 'gitignore'),
      ).to.be.true;

      // Same selection, flag off — proves the bug is real by default: folder
      // 0's (irrelevant) .gitignore is consulted instead of rootB's own, so
      // secret.ts wrongly slips through.
      const legacy = await generateHandoff(
        selection,
        { ...baseOpts, smartFilter: false },
        root,
        folders,
      );
      expect(legacy.included.map((f) => f.relativePath).sort()).to.deep.equal(['ok.ts', 'secret.ts']);
    } finally {
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it('flag on: resolves correctly even when relativePath already carries a sidebar-style folder-name prefix', async () => {
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-rootb-prefix-'));
    try {
      await fs.writeFile(path.join(rootB, 'helper.ts'), 'export const h = 2;');
      const folders = [
        { name: path.basename(root), path: root },
        { name: path.basename(rootB), path: rootB },
      ];

      // Ad hoc entry point convention (collectExplorerFiles): no folder-name prefix.
      const unprefixed = await generateHandoff(
        [{ relativePath: 'helper.ts', absolutePath: path.join(rootB, 'helper.ts') }],
        { ...baseOpts, smartFilter: false, accurateMultiRootPaths: true },
        root,
        folders,
      );
      // Sidebar entry point convention (FileTreeModel.toRelative()): prefixed.
      const prefixed = await generateHandoff(
        [
          {
            relativePath: `${path.basename(rootB)}/helper.ts`,
            absolutePath: path.join(rootB, 'helper.ts'),
          },
        ],
        { ...baseOpts, smartFilter: false, accurateMultiRootPaths: true },
        root,
        folders,
      );

      expect(prefixed.included).to.have.lengthOf(1);
      expect(prefixed.included[0].relativePath).to.equal(unprefixed.included[0].relativePath);
      expect(prefixed.text).to.include(`${path.basename(rootB)}/`);
    } finally {
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });
});
