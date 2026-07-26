import { expect } from 'chai';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { WorkspaceFolder } from 'vscode';
import { parseSearchQuery } from '../../core/search-filter';
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

async function makeSearchRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-tree-search-'));
  await fs.mkdir(path.join(root, 'src', 'auth'), { recursive: true });
  await fs.mkdir(path.join(root, 'src', 'utils'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# readme');
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const x = 1;');
  await fs.writeFile(path.join(root, 'src', 'auth', 'login.ts'), 'export const login = () => {};');
  await fs.writeFile(
    path.join(root, 'src', 'auth', 'login.test.ts'),
    'test("login", () => {});',
  );
  await fs.writeFile(path.join(root, 'src', 'utils', 'format.js'), 'module.exports = {};');
  await fs.writeFile(path.join(root, 'docs', 'guide.md'), '# guide');
  return root;
}

async function collectVisiblePaths(
  provider: FileTreeProvider,
  parent?: FileTreeItem,
): Promise<string[]> {
  const children = await provider.getChildren(parent);
  const paths: string[] = [];
  for (const child of children) {
    paths.push(child.data.relativePath);
    if (child.data.isDirectory) {
      paths.push(...(await collectVisiblePaths(provider, child)));
    }
  }
  return paths.sort();
}

describe('FileTreeProvider — search filter', () => {
  let root: string;
  let provider: FileTreeProvider;

  beforeEach(async () => {
    root = await makeSearchRoot();
    provider = new FileTreeProvider([fakeFolder(root, 0)]);
  });
  afterEach(async () => {
    provider.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('shows everything when no search query is set', async () => {
    expect(await collectVisiblePaths(provider)).to.deep.equal(
      [
        'README.md',
        'docs',
        'docs/guide.md',
        'src',
        'src/auth',
        'src/auth/login.test.ts',
        'src/auth/login.ts',
        'src/index.ts',
        'src/utils',
        'src/utils/format.js',
      ].sort(),
    );
  });

  it('name mode: keeps matching files and any ancestor directory, hides the rest', async () => {
    provider.setSearchQuery(parseSearchQuery('login').query);
    expect(await collectVisiblePaths(provider)).to.deep.equal(
      ['src', 'src/auth', 'src/auth/login.ts', 'src/auth/login.test.ts'].sort(),
    );
  });

  it('extension mode: matches by extension regardless of directory', async () => {
    provider.setSearchQuery(parseSearchQuery('ext:ts').query);
    expect(await collectVisiblePaths(provider)).to.deep.equal(
      ['src', 'src/auth', 'src/auth/login.ts', 'src/auth/login.test.ts', 'src/index.ts'].sort(),
    );
  });

  it('regex mode: matches the relative path against the pattern', async () => {
    provider.setSearchQuery(parseSearchQuery('re:\\.test\\.ts$').query);
    expect(await collectVisiblePaths(provider)).to.deep.equal(
      ['src', 'src/auth', 'src/auth/login.test.ts'].sort(),
    );
  });

  it('a query matching nothing hides the whole tree', async () => {
    provider.setSearchQuery(parseSearchQuery('nope-not-here').query);
    expect(await collectVisiblePaths(provider)).to.deep.equal([]);
  });

  it('clearing the query (undefined) restores the full tree', async () => {
    provider.setSearchQuery(parseSearchQuery('login').query);
    provider.setSearchQuery(undefined);
    expect(await collectVisiblePaths(provider)).to.have.lengthOf(10);
  });

  it('is a display-only filter — an already-selected file stays selected once hidden', async () => {
    // Select src/utils/format.js directly via toggleFile, matching how the
    // sidebar checkbox path selects an individual file.
    await provider.toggleFile('src/utils/format.js', true);
    provider.setSearchQuery(parseSearchQuery('login').query);
    // format.js no longer matches "login" and is hidden from the tree...
    expect(await collectVisiblePaths(provider)).to.not.include('src/utils/format.js');
    // ...but the selection itself is untouched.
    expect(provider.getSelection()).to.deep.equal(['src/utils/format.js']);
  });

  it('auto-expands directories while a search is active', async () => {
    const withoutSearch = await provider.getChildren(undefined);
    const srcCollapsed = withoutSearch.find((c) => c.data.name === 'src')!;
    expect(srcCollapsed.collapsibleState).to.equal(1); // Collapsed

    provider.setSearchQuery(parseSearchQuery('login').query);
    const withSearch = await provider.getChildren(undefined);
    const srcExpanded = withSearch.find((c) => c.data.name === 'src')!;
    expect(srcExpanded.collapsibleState).to.equal(2); // Expanded
  });
});

describe('FileTreeProvider — directory collapsibleState defaults', () => {
  let root: string;
  let provider: FileTreeProvider;

  beforeEach(async () => {
    root = await makeSearchRoot();
    provider = new FileTreeProvider([fakeFolder(root, 0)]);
  });
  afterEach(async () => {
    provider.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('regular directories default to collapsed with no search active', async () => {
    const children = await provider.getChildren(undefined);
    expect(children.find((c) => c.data.name === 'src')!.collapsibleState).to.equal(1); // Collapsed
  });

  it('directories default to expanded while a search is active, including ones never rendered before', async () => {
    provider.setSearchQuery(parseSearchQuery('login').query);
    const children = await provider.getChildren(undefined);
    const src = children.find((c) => c.data.name === 'src')!;
    expect(src.collapsibleState).to.equal(2); // Expanded
    const srcChildren = await provider.getChildren(src);
    const auth = srcChildren.find((c) => c.data.name === 'auth')!;
    expect(auth.collapsibleState).to.equal(2); // Expanded
  });
});

describe('FileTreeProvider — top-level multi-root folder nodes', () => {
  let rootA: string;
  let rootB: string;
  let provider: FileTreeProvider;

  before(async () => {
    rootA = await makeRoot('aih-tree-toggle-a-');
    rootB = await makeRoot('aih-tree-toggle-b-');
    provider = new FileTreeProvider([fakeFolder(rootA, 0), fakeFolder(rootB, 1)]);
  });
  after(async () => {
    provider.dispose();
    await fs.rm(rootA, { recursive: true, force: true });
    await fs.rm(rootB, { recursive: true, force: true });
  });

  it('top-level folder nodes default to expanded', async () => {
    const children = await provider.getChildren(undefined);
    expect(children.every((c) => c.collapsibleState === 2)).to.be.true; // Expanded
  });
});

describe('FileTreeProvider — getParent', () => {
  describe('single-root workspace', () => {
    let root: string;
    let provider: FileTreeProvider;

    before(async () => {
      root = await makeRoot('aih-tree-getparent-single-');
    });
    beforeEach(() => {
      provider = new FileTreeProvider([fakeFolder(root, 0)]);
    });
    afterEach(() => provider.dispose());
    after(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    it('returns undefined for a top-level item (the root has no node of its own)', async () => {
      const children = await provider.getChildren(undefined);
      const src = children.find((c) => c.data.name === 'src')!;
      expect(provider.getParent(src)).to.be.undefined;
    });

    it('returns the correct parent directory for a nested item', async () => {
      const children = await provider.getChildren(undefined);
      const src = children.find((c) => c.data.name === 'src')!;
      const grandchildren = await provider.getChildren(src);
      const indexTs = grandchildren.find((c) => c.data.name === 'index.ts')!;
      const parent = provider.getParent(indexTs);
      expect(parent?.data.relativePath).to.equal('src');
      expect(parent?.data.isDirectory).to.be.true;
    });
  });

  describe('multi-root workspace', () => {
    let rootA: string;
    let rootB: string;
    let provider: FileTreeProvider;

    before(async () => {
      rootA = await makeRoot('aih-tree-getparent-a-');
      rootB = await makeRoot('aih-tree-getparent-b-');
      provider = new FileTreeProvider([fakeFolder(rootA, 0), fakeFolder(rootB, 1)]);
    });
    after(async () => {
      provider.dispose();
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    });

    it('returns undefined for a top-level folder-root node', async () => {
      const [folderANode] = await provider.getChildren(undefined);
      expect(provider.getParent(folderANode)).to.be.undefined;
    });

    it("returns the owning folder's top-level node as the parent of its direct children", async () => {
      const [folderANode] = await provider.getChildren(undefined);
      const aChildren = await provider.getChildren(folderANode);
      const src = aChildren.find((c) => c.data.name === 'src')!;
      const parent = provider.getParent(src);
      expect(parent?.data.relativePath).to.equal(path.basename(rootA));
      expect(parent?.data.absolutePath).to.equal(rootA);
    });

    it('returns the correct parent for a deeply nested item, scoped to its own folder', async () => {
      const [, folderBNode] = await provider.getChildren(undefined);
      const bChildren = await provider.getChildren(folderBNode);
      const src = bChildren.find((c) => c.data.name === 'src')!;
      const grandchildren = await provider.getChildren(src);
      const indexTs = grandchildren.find((c) => c.data.name === 'index.ts')!;
      const parent = provider.getParent(indexTs);
      expect(parent?.data.relativePath).to.equal(`${path.basename(rootB)}/src`);
    });
  });
});

describe('FileTreeProvider — onDidToggleIndividualFile', () => {
  let root: string;
  let provider: FileTreeProvider;

  before(async () => {
    root = await makeRoot('aih-tree-individual-');
  });
  beforeEach(() => {
    provider = new FileTreeProvider([fakeFolder(root, 0)]);
  });
  afterEach(() => {
    provider.dispose();
  });
  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('fires with the path and checked=true when a single file is ticked', async () => {
    const events: { relativePath: string; checked: boolean }[] = [];
    provider.onDidToggleIndividualFile((e) => events.push(e));

    await provider.toggleFile('src/index.ts', true);
    expect(events).to.deep.equal([{ relativePath: 'src/index.ts', checked: true }]);
  });

  it('fires with checked=false when a single file is unticked', async () => {
    const events: { relativePath: string; checked: boolean }[] = [];
    await provider.toggleFile('src/index.ts', true);
    provider.onDidToggleIndividualFile((e) => events.push(e));

    await provider.toggleFile('src/index.ts', false);
    expect(events).to.deep.equal([{ relativePath: 'src/index.ts', checked: false }]);
  });

  it('does NOT fire when a whole directory is toggled — bulk-selecting a folder should stay subject to filters', async () => {
    const children = await provider.getChildren(undefined);
    const srcDir = children.find((c) => c.data.name === 'src')!;

    const events: { relativePath: string; checked: boolean }[] = [];
    provider.onDidToggleIndividualFile((e) => events.push(e));

    await provider.toggleDirectory(srcDir.data, true);
    expect(events).to.deep.equal([]);
    expect(provider.getSelection()).to.deep.equal(['src/index.ts']);
  });
});
