import { expect } from 'chai';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { WorkspaceFolder } from 'vscode';
import { FileTreeProvider, FileTreeItem } from '../../ui/file-tree-provider';

function fakeFolder(root: string, index: number): WorkspaceFolder {
  return {
    uri: { fsPath: root } as WorkspaceFolder['uri'],
    name: path.basename(root),
    index,
  };
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# readme');
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const x = 1;');
  return root;
}

async function childNames(items: FileTreeItem[]): Promise<string[]> {
  return items.map((i) => i.data.name);
}

describe('FileTreeProvider — single-root workspace', () => {
  let root: string;
  let provider: FileTreeProvider;

  before(async () => {
    root = await makeRoot('aih-tree-single-');
    provider = new FileTreeProvider([fakeFolder(root, 0)]);
  });
  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('lists the sole folder\'s contents directly at the top level (no wrapper node)', async () => {
    const children = await provider.getChildren(undefined);
    expect(await childNames(children)).to.deep.equal(['src', 'README.md']);
  });

  it('uses unprefixed relative paths', async () => {
    const children = await provider.getChildren(undefined);
    const srcDir = children.find((c) => c.data.name === 'src')!;
    const grandchildren = await provider.getChildren(srcDir);
    expect(grandchildren[0].data.relativePath).to.equal('src/index.ts');
  });

  it('toggling the src directory selects its descendant files by unprefixed path', async () => {
    const children = await provider.getChildren(undefined);
    const srcDir = children.find((c) => c.data.name === 'src')!;
    await provider.toggleDirectory(srcDir.data, true);
    expect(provider.getSelection()).to.deep.equal(['src/index.ts']);
    await provider.toggleDirectory(srcDir.data, false);
    expect(provider.getSelection()).to.deep.equal([]);
  });

  it('resolveAbsolutePath joins directly against the single root', () => {
    expect(provider.resolveAbsolutePath('src/index.ts')).to.equal(
      path.join(root, 'src', 'index.ts'),
    );
  });
});

describe('FileTreeProvider — multi-root workspace', () => {
  let rootA: string;
  let rootB: string;
  let provider: FileTreeProvider;

  before(async () => {
    rootA = await makeRoot('aih-tree-multi-a-');
    rootB = await makeRoot('aih-tree-multi-b-');
    provider = new FileTreeProvider([fakeFolder(rootA, 0), fakeFolder(rootB, 1)]);
  });
  after(async () => {
    await fs.rm(rootA, { recursive: true, force: true });
    await fs.rm(rootB, { recursive: true, force: true });
  });

  it('surfaces every workspace folder as a top-level node, not just the first', async () => {
    const children = await provider.getChildren(undefined);
    expect(await childNames(children)).to.deep.equal([
      path.basename(rootA),
      path.basename(rootB),
    ]);
    expect(children.every((c) => c.data.isDirectory)).to.be.true;
  });

  it('prefixes relative paths with the owning folder name below each root', async () => {
    const [folderANode, folderBNode] = await provider.getChildren(undefined);
    const aChildren = await provider.getChildren(folderANode);
    const bChildren = await provider.getChildren(folderBNode);
    const aSrc = aChildren.find((c) => c.data.name === 'src')!;
    const bSrc = bChildren.find((c) => c.data.name === 'src')!;
    const aGrandchildren = await provider.getChildren(aSrc);
    const bGrandchildren = await provider.getChildren(bSrc);
    expect(aGrandchildren[0].data.relativePath).to.equal(`${path.basename(rootA)}/src/index.ts`);
    expect(bGrandchildren[0].data.relativePath).to.equal(`${path.basename(rootB)}/src/index.ts`);
  });

  it('can select files from the second workspace folder, not just the first', async () => {
    const [, folderBNode] = await provider.getChildren(undefined);
    await provider.toggleDirectory(folderBNode.data, true);
    expect(provider.getSelection()).to.deep.equal([
      `${path.basename(rootB)}/README.md`,
      `${path.basename(rootB)}/src/index.ts`,
    ]);
    await provider.toggleDirectory(folderBNode.data, false);
    expect(provider.getSelection()).to.deep.equal([]);
  });

  it('can select files from both folders at once', async () => {
    const [folderANode, folderBNode] = await provider.getChildren(undefined);
    await provider.toggleDirectory(folderANode.data, true);
    await provider.toggleDirectory(folderBNode.data, true);
    expect(provider.getSelection()).to.deep.equal([
      `${path.basename(rootA)}/README.md`,
      `${path.basename(rootA)}/src/index.ts`,
      `${path.basename(rootB)}/README.md`,
      `${path.basename(rootB)}/src/index.ts`,
    ]);
    await provider.toggleDirectory(folderANode.data, false);
    await provider.toggleDirectory(folderBNode.data, false);
  });

  it('resolveAbsolutePath resolves the folder-name-prefixed path back to the right folder', () => {
    expect(provider.resolveAbsolutePath(`${path.basename(rootA)}/src/index.ts`)).to.equal(
      path.join(rootA, 'src', 'index.ts'),
    );
    expect(provider.resolveAbsolutePath(`${path.basename(rootB)}/README.md`)).to.equal(
      path.join(rootB, 'README.md'),
    );
  });

  it('resolveAbsolutePath returns undefined for an unknown folder prefix', () => {
    expect(provider.resolveAbsolutePath('not-a-real-folder/index.ts')).to.be.undefined;
  });
});
