import { expect } from 'chai';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { generateHandoffFromRefDiff, RefDiffError, type RefDiffGenerateOptions } from '../../services/ref-diff-generator';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd });
}

async function initRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-refdiffgen-'));
  git(root, ['init', '-q']);
  git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  return root;
}

async function commitAll(root: string, message = 'init'): Promise<void> {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
}

const baseOptions: RefDiffGenerateOptions = {
  format: 'plain',
  includeLineNumbers: true,
  maxFileSizeKB: 1024,
  binaryHandling: 'placeholder',
  tokenEstimationRatio: 4,
};

describe('generateHandoffFromRefDiff', () => {
  it('includes full file content numbered from line 1, not a diff hunk', async () => {
    const root = await initRepo();
    try {
      await fs.writeFile(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
      await commitAll(root);
      git(root, ['checkout', '-b', 'feature']);
      await fs.writeFile(path.join(root, 'a.txt'), 'one\ntwo\nTHREE CHANGED\nfour\n');
      await commitAll(root, 'feature work');

      const result = await generateHandoffFromRefDiff(
        [{ name: path.basename(root), path: root }],
        'main',
        'feature',
        baseOptions,
      );

      expect(result.included).to.have.lengthOf(1);
      expect(result.included[0].relativePath).to.equal('a.txt');
      expect(result.text).to.include('1  one');
      expect(result.text).to.include('4  four');
      expect(result.text).to.not.include('+one');
      expect(result.text).to.not.include('@@');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('skips files over the size limit', async () => {
    const root = await initRepo();
    try {
      await fs.writeFile(path.join(root, 'a.txt'), 'small\n');
      await commitAll(root);
      git(root, ['checkout', '-b', 'feature']);
      await fs.writeFile(path.join(root, 'big.txt'), `${'x'.repeat(2048)}\n`);
      await commitAll(root, 'add big file');

      const result = await generateHandoffFromRefDiff(
        [{ name: path.basename(root), path: root }],
        'main',
        'feature',
        { ...baseOptions, maxFileSizeKB: 1 },
      );

      expect(result.included).to.have.lengthOf(0);
      expect(result.skipped).to.have.lengthOf(1);
      expect(result.skipped[0].reason).to.equal('too-large');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('handles binary files as a placeholder by default, or skips them when binaryHandling is "skip"', async () => {
    const root = await initRepo();
    try {
      await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
      await commitAll(root);
      git(root, ['checkout', '-b', 'feature']);
      await fs.writeFile(path.join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
      await commitAll(root, 'add binary');

      const placeholderResult = await generateHandoffFromRefDiff(
        [{ name: path.basename(root), path: root }],
        'main',
        'feature',
        baseOptions,
      );
      expect(placeholderResult.included).to.have.lengthOf(1);
      expect(placeholderResult.included[0].isBinary).to.be.true;
      expect(placeholderResult.skipped).to.have.lengthOf(0);

      const skipResult = await generateHandoffFromRefDiff(
        [{ name: path.basename(root), path: root }],
        'main',
        'feature',
        { ...baseOptions, binaryHandling: 'skip' },
      );
      expect(skipResult.included).to.have.lengthOf(0);
      expect(skipResult.skipped).to.have.lengthOf(1);
      expect(skipResult.skipped[0].reason).to.equal('binary-skip');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('base64-encodes the final text when base64Encode is set, stats stay computed on the real content', async () => {
    const root = await initRepo();
    try {
      await fs.writeFile(path.join(root, 'a.txt'), 'hello\n');
      await commitAll(root);
      git(root, ['checkout', '-b', 'feature']);
      await fs.writeFile(path.join(root, 'a.txt'), 'hello world\n');
      await commitAll(root, 'feature work');

      const plain = await generateHandoffFromRefDiff(
        [{ name: path.basename(root), path: root }],
        'main',
        'feature',
        baseOptions,
      );
      const encoded = await generateHandoffFromRefDiff(
        [{ name: path.basename(root), path: root }],
        'main',
        'feature',
        { ...baseOptions, base64Encode: true },
      );

      expect(encoded.text).to.equal(Buffer.from(plain.text, 'utf-8').toString('base64'));
      expect(encoded.stats.totalSizeBytes).to.equal(plain.stats.totalSizeBytes);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('throws RefDiffError when base and compare refs are the same', async () => {
    const root = await initRepo();
    try {
      await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
      await commitAll(root);

      let error: unknown;
      try {
        await generateHandoffFromRefDiff([{ name: path.basename(root), path: root }], 'main', 'main', baseOptions);
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(RefDiffError);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('throws RefDiffError when no git repository is found in the workspace', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-plain-'));
    try {
      let error: unknown;
      try {
        await generateHandoffFromRefDiff(
          [{ name: path.basename(plain), path: plain }],
          'main',
          'feature',
          baseOptions,
        );
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(RefDiffError);
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });
});
