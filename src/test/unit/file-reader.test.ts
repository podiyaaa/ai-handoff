import { expect } from 'chai';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readFile, statFile } from '../../services/file-reader';

describe('statFile', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-reader-'));
  });
  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns size for a real file', async () => {
    const p = path.join(tmpDir, 'a.txt');
    await fs.writeFile(p, 'hello');
    expect(await statFile(p)).to.equal(5);
  });

  it('returns null for a missing file', async () => {
    expect(await statFile(path.join(tmpDir, 'nope.txt'))).to.be.null;
  });

  it('returns null for a directory', async () => {
    expect(await statFile(tmpDir)).to.be.null;
  });
});

describe('readFile', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-reader-'));
  });
  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads a text file as utf-8', async () => {
    const p = path.join(tmpDir, 'plain.txt');
    await fs.writeFile(p, 'hello world');
    const result = await readFile({ relativePath: 'plain.txt', absolutePath: p });
    expect(result.kind).to.equal('text');
    if (result.kind === 'text') {
      expect(result.file.content).to.equal('hello world');
      expect(result.file.isBinary).to.be.false;
      expect(result.file.sizeBytes).to.equal(11);
    }
  });

  it('detects binaries by extension without reading content', async () => {
    const p = path.join(tmpDir, 'logo.png');
    await fs.writeFile(p, Buffer.from('not actually a png but ok'));
    const result = await readFile({ relativePath: 'logo.png', absolutePath: p });
    expect(result.kind).to.equal('binary');
    if (result.kind === 'binary') {
      expect(result.file.content).to.be.null;
      expect(result.file.isBinary).to.be.true;
    }
  });

  it('detects binaries by NUL byte for unknown extensions', async () => {
    const p = path.join(tmpDir, 'compiled-blob');
    await fs.writeFile(p, Buffer.from([0x48, 0x00, 0x65, 0x00]));
    const result = await readFile({ relativePath: 'compiled-blob', absolutePath: p });
    expect(result.kind).to.equal('binary');
  });

  it('handles utf-8 text with multi-byte characters', async () => {
    const p = path.join(tmpDir, 'unicode.md');
    await fs.writeFile(p, 'café — résumé — 日本語');
    const result = await readFile({ relativePath: 'unicode.md', absolutePath: p });
    expect(result.kind).to.equal('text');
    if (result.kind === 'text') {
      expect(result.file.content).to.equal('café — résumé — 日本語');
    }
  });

  it('returns an error result for a missing file', async () => {
    const result = await readFile({
      relativePath: 'nope.txt',
      absolutePath: path.join(tmpDir, 'nope.txt'),
    });
    expect(result.kind).to.equal('error');
  });

  it('returns an error result for a directory', async () => {
    const sub = path.join(tmpDir, 'subdir');
    await fs.mkdir(sub);
    const result = await readFile({ relativePath: 'subdir', absolutePath: sub });
    expect(result.kind).to.equal('error');
  });

  it('handles empty files as text with empty content', async () => {
    const p = path.join(tmpDir, 'empty.txt');
    await fs.writeFile(p, '');
    const result = await readFile({ relativePath: 'empty.txt', absolutePath: p });
    expect(result.kind).to.equal('text');
    if (result.kind === 'text') {
      expect(result.file.content).to.equal('');
      expect(result.file.sizeBytes).to.equal(0);
    }
  });
});
