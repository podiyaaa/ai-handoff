import { expect } from 'chai';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { generateHandoff, readGitignore } from '../../services/handoff-generator';
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
});
