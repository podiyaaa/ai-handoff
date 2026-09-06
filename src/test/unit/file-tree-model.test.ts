import { expect } from 'chai';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { WorkspaceFolder } from 'vscode';
import { parseSearchQuery } from '../../core/search-filter';
import type { TreeNodeInfo } from '../../core/types';
import { FileTreeModel } from '../../services/file-tree-model';

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

function childNames(items: TreeNodeInfo[]): string[] {
  return items.map((i) => i.name);
}

describe('FileTreeModel — single-root workspace', () => {
  let root: string;
  let model: FileTreeModel;

  before(async () => {
    root = await makeRoot('aih-tree-single-');
    model = new FileTreeModel([fakeFolder(root, 0)]);
  });
  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists the sole folder's contents directly at the top level (no wrapper node)", async () => {
    const children = await model.getChildren(undefined);
    expect(childNames(children)).to.deep.equal(['src', 'README.md']);
  });

  it('uses unprefixed relative paths', async () => {
    const children = await model.getChildren(undefined);
    const srcDir = children.find((c) => c.name === 'src')!;
    const grandchildren = await model.getChildren(srcDir.relativePath);
    expect(grandchildren[0].relativePath).to.equal('src/index.ts');
  });

  it('toggling the src directory selects its descendant files by unprefixed path', async () => {
    const children = await model.getChildren(undefined);
    const srcDir = children.find((c) => c.name === 'src')!;
    await model.toggleDirectory(srcDir.relativePath, true);
    expect(model.getSelection()).to.deep.equal(['src/index.ts']);
    await model.toggleDirectory(srcDir.relativePath, false);
    expect(model.getSelection()).to.deep.equal([]);
  });

  it('resolveAbsolutePath joins directly against the single root', () => {
    expect(model.resolveAbsolutePath('src/index.ts')).to.equal(path.join(root, 'src', 'index.ts'));
  });

  it('absoluteToOwningRelative is the exact inverse of resolveAbsolutePath for a single root', () => {
    expect(model.absoluteToOwningRelative(path.join(root, 'src', 'index.ts'))).to.equal('src/index.ts');
  });

  it('absoluteToOwningRelative returns undefined for a path outside every workspace folder', () => {
    expect(model.absoluteToOwningRelative('/definitely/outside/the/workspace.ts')).to.be.undefined;
  });
});

describe('FileTreeModel — multi-root workspace', () => {
  let rootA: string;
  let rootB: string;
  let model: FileTreeModel;

  before(async () => {
    rootA = await makeRoot('aih-tree-multi-a-');
    rootB = await makeRoot('aih-tree-multi-b-');
    model = new FileTreeModel([fakeFolder(rootA, 0), fakeFolder(rootB, 1)]);
  });
  after(async () => {
    await fs.rm(rootA, { recursive: true, force: true });
    await fs.rm(rootB, { recursive: true, force: true });
  });

  it('surfaces every workspace folder as a top-level node, not just the first', async () => {
    const children = await model.getChildren(undefined);
    expect(childNames(children)).to.deep.equal([path.basename(rootA), path.basename(rootB)]);
    expect(children.every((c) => c.isDirectory)).to.be.true;
  });

  it('prefixes relative paths with the owning folder name below each root', async () => {
    const [folderA, folderB] = await model.getChildren(undefined);
    const aChildren = await model.getChildren(folderA.relativePath);
    const bChildren = await model.getChildren(folderB.relativePath);
    const aSrc = aChildren.find((c) => c.name === 'src')!;
    const bSrc = bChildren.find((c) => c.name === 'src')!;
    const aGrandchildren = await model.getChildren(aSrc.relativePath);
    const bGrandchildren = await model.getChildren(bSrc.relativePath);
    expect(aGrandchildren[0].relativePath).to.equal(`${path.basename(rootA)}/src/index.ts`);
    expect(bGrandchildren[0].relativePath).to.equal(`${path.basename(rootB)}/src/index.ts`);
  });

  it('can select files from the second workspace folder, not just the first', async () => {
    const [, folderB] = await model.getChildren(undefined);
    await model.toggleDirectory(folderB.relativePath, true);
    expect(model.getSelection()).to.deep.equal([
      `${path.basename(rootB)}/README.md`,
      `${path.basename(rootB)}/src/index.ts`,
    ]);
    await model.toggleDirectory(folderB.relativePath, false);
    expect(model.getSelection()).to.deep.equal([]);
  });

  it('can select files from both folders at once', async () => {
    const [folderA, folderB] = await model.getChildren(undefined);
    await model.toggleDirectory(folderA.relativePath, true);
    await model.toggleDirectory(folderB.relativePath, true);
    expect(model.getSelection()).to.deep.equal([
      `${path.basename(rootA)}/README.md`,
      `${path.basename(rootA)}/src/index.ts`,
      `${path.basename(rootB)}/README.md`,
      `${path.basename(rootB)}/src/index.ts`,
    ]);
    await model.toggleDirectory(folderA.relativePath, false);
    await model.toggleDirectory(folderB.relativePath, false);
  });

  it('resolveAbsolutePath resolves the folder-name-prefixed path back to the right folder', () => {
    expect(model.resolveAbsolutePath(`${path.basename(rootA)}/src/index.ts`)).to.equal(
      path.join(rootA, 'src', 'index.ts'),
    );
    expect(model.resolveAbsolutePath(`${path.basename(rootB)}/README.md`)).to.equal(
      path.join(rootB, 'README.md'),
    );
  });

  it('resolveAbsolutePath returns undefined for an unknown folder prefix', () => {
    expect(model.resolveAbsolutePath('not-a-real-folder/index.ts')).to.be.undefined;
  });

  it('absoluteToOwningRelative prefixes with the owning folder name, the exact inverse of resolveAbsolutePath', () => {
    expect(model.absoluteToOwningRelative(path.join(rootA, 'src', 'index.ts'))).to.equal(
      `${path.basename(rootA)}/src/index.ts`,
    );
    expect(model.absoluteToOwningRelative(path.join(rootB, 'README.md'))).to.equal(
      `${path.basename(rootB)}/README.md`,
    );
  });

  it('absoluteToOwningRelative returns undefined for a path outside both workspace folders', () => {
    expect(model.absoluteToOwningRelative('/definitely/outside/both/roots.ts')).to.be.undefined;
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
  await fs.writeFile(path.join(root, 'src', 'auth', 'login.test.ts'), 'test("login", () => {});');
  await fs.writeFile(path.join(root, 'src', 'utils', 'format.js'), 'module.exports = {};');
  await fs.writeFile(path.join(root, 'docs', 'guide.md'), '# guide');
  return root;
}

async function collectVisiblePaths(model: FileTreeModel, relativePath?: string): Promise<string[]> {
  const children = await model.getChildren(relativePath);
  const paths: string[] = [];
  for (const child of children) {
    paths.push(child.relativePath);
    if (child.isDirectory) {
      paths.push(...(await collectVisiblePaths(model, child.relativePath)));
    }
  }
  return paths.sort();
}

describe('FileTreeModel — search filter', () => {
  let root: string;
  let model: FileTreeModel;

  beforeEach(async () => {
    root = await makeSearchRoot();
    model = new FileTreeModel([fakeFolder(root, 0)]);
  });
  afterEach(async () => {
    model.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('shows everything when no search query is set', async () => {
    expect(await collectVisiblePaths(model)).to.deep.equal(
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
    model.setSearchQuery(parseSearchQuery('login').query);
    expect(await collectVisiblePaths(model)).to.deep.equal(
      ['src', 'src/auth', 'src/auth/login.ts', 'src/auth/login.test.ts'].sort(),
    );
  });

  it('extension mode: matches by extension regardless of directory', async () => {
    model.setSearchQuery(parseSearchQuery('ext:ts').query);
    expect(await collectVisiblePaths(model)).to.deep.equal(
      ['src', 'src/auth', 'src/auth/login.ts', 'src/auth/login.test.ts', 'src/index.ts'].sort(),
    );
  });

  it('regex mode: matches the relative path against the pattern', async () => {
    model.setSearchQuery(parseSearchQuery('re:\\.test\\.ts$').query);
    expect(await collectVisiblePaths(model)).to.deep.equal(['src', 'src/auth', 'src/auth/login.test.ts'].sort());
  });

  it('a query matching nothing hides the whole tree', async () => {
    model.setSearchQuery(parseSearchQuery('nope-not-here').query);
    expect(await collectVisiblePaths(model)).to.deep.equal([]);
  });

  it('clearing the query (undefined) restores the full tree', async () => {
    model.setSearchQuery(parseSearchQuery('login').query);
    model.setSearchQuery(undefined);
    expect(await collectVisiblePaths(model)).to.have.lengthOf(10);
  });

  it('is a display-only filter — an already-selected file stays selected once hidden', async () => {
    await model.toggleFile('src/utils/format.js', true);
    model.setSearchQuery(parseSearchQuery('login').query);
    expect(await collectVisiblePaths(model)).to.not.include('src/utils/format.js');
    expect(model.getSelection()).to.deep.equal(['src/utils/format.js']);
  });

  it('getChildren() reports checkboxState and matchesSearch inline, with no second round trip needed', async () => {
    await model.toggleFile('src/index.ts', true);
    model.setSearchQuery(parseSearchQuery('index').query);

    const children = await model.getChildren(undefined);
    const src = children.find((c) => c.name === 'src')!;
    expect(src.matchesSearch).to.be.false;
    expect(src.checkboxState).to.equal('unchecked');

    const srcChildren = await model.getChildren('src');
    const indexTs = srcChildren.find((c) => c.name === 'index.ts')!;
    expect(indexTs.matchesSearch).to.be.true;
    expect(indexTs.checkboxState).to.equal('checked');
  });
});

describe('FileTreeModel — show selected only', () => {
  let root: string;
  let model: FileTreeModel;

  beforeEach(async () => {
    root = await makeSearchRoot();
    model = new FileTreeModel([fakeFolder(root, 0)]);
  });
  afterEach(async () => {
    model.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('shows everything when the filter is off (the default)', async () => {
    expect(await collectVisiblePaths(model)).to.have.lengthOf(10);
  });

  it('keeps only selected files and their ancestor directories', async () => {
    await model.toggleFile('src/auth/login.ts', true);
    model.setShowSelectedOnly(true);
    expect(await collectVisiblePaths(model)).to.deep.equal(['src', 'src/auth', 'src/auth/login.ts'].sort());
  });

  it('with nothing selected, hides the whole tree', async () => {
    model.setShowSelectedOnly(true);
    expect(await collectVisiblePaths(model)).to.deep.equal([]);
  });

  it('is a display-only filter — turning it off restores the full tree, selection untouched', async () => {
    await model.toggleFile('README.md', true);
    model.setShowSelectedOnly(true);
    model.setShowSelectedOnly(false);
    expect(await collectVisiblePaths(model)).to.have.lengthOf(10);
    expect(model.getSelection()).to.deep.equal(['README.md']);
  });

  it('reflects selection changes made while the filter is already active', async () => {
    await model.toggleFile('README.md', true);
    model.setShowSelectedOnly(true);
    expect(await collectVisiblePaths(model)).to.deep.equal(['README.md']);

    await model.toggleFile('src/index.ts', true);
    expect(await collectVisiblePaths(model)).to.deep.equal(['README.md', 'src', 'src/index.ts'].sort());

    await model.toggleFile('README.md', false);
    expect(await collectVisiblePaths(model)).to.deep.equal(['src', 'src/index.ts'].sort());
  });

  it('toggling a whole directory selects all its descendants, all of which stay visible', async () => {
    model.setShowSelectedOnly(true);
    await model.toggleDirectory('src/auth', true);
    expect(await collectVisiblePaths(model)).to.deep.equal(
      ['src', 'src/auth', 'src/auth/login.ts', 'src/auth/login.test.ts'].sort(),
    );
  });

  it('clearSelection() empties the filtered view too', async () => {
    await model.toggleFile('README.md', true);
    model.setShowSelectedOnly(true);
    await model.clearSelection();
    expect(await collectVisiblePaths(model)).to.deep.equal([]);
  });

  it('combines with an active search query (AND, not OR)', async () => {
    await model.toggleFile('src/auth/login.ts', true);
    await model.toggleFile('src/index.ts', true);
    model.setShowSelectedOnly(true);
    model.setSearchQuery(parseSearchQuery('login').query);
    // Both files are selected, but only login.ts also matches the search —
    // index.ts is selected yet not shown, since it fails the search half.
    expect(await collectVisiblePaths(model)).to.deep.equal(['src', 'src/auth', 'src/auth/login.ts'].sort());
  });

  it('getVisibleRows() auto-expands every ancestor directory, with no manual expand needed', async () => {
    await model.toggleFile('src/auth/login.ts', true);
    model.setShowSelectedOnly(true);
    const rows = await model.getVisibleRows();
    expect(rows.map((r) => r.relativePath).sort()).to.deep.equal(['src', 'src/auth', 'src/auth/login.ts'].sort());
  });
});

describe('FileTreeModel — getVisibleRows', () => {
  let root: string;
  let model: FileTreeModel;

  beforeEach(async () => {
    root = await makeSearchRoot();
    model = new FileTreeModel([fakeFolder(root, 0)]);
  });
  afterEach(async () => {
    model.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('with nothing expanded, only shows the top level', async () => {
    const rows = await model.getVisibleRows();
    expect(rows.map((r) => r.relativePath).sort()).to.deep.equal(['README.md', 'docs', 'src'].sort());
  });

  it('expanding a directory reveals its children, without expanding siblings', async () => {
    model.setExpanded('src', true);
    const rows = await model.getVisibleRows();
    expect(rows.map((r) => r.relativePath).sort()).to.deep.equal(
      ['README.md', 'docs', 'src', 'src/auth', 'src/index.ts', 'src/utils'].sort(),
    );
  });

  it('expanding a nested directory reveals its own children too', async () => {
    model.setExpanded('src', true);
    model.setExpanded('src/auth', true);
    const rows = await model.getVisibleRows();
    expect(rows.map((r) => r.relativePath)).to.include('src/auth/login.ts');
    expect(rows.map((r) => r.relativePath)).to.include('src/auth/login.test.ts');
  });

  it('collapsing a directory hides its children again', async () => {
    model.setExpanded('src', true);
    expect(model.isExpanded('src')).to.be.true;
    model.setExpanded('src', false);
    expect(model.isExpanded('src')).to.be.false;
    const rows = await model.getVisibleRows();
    expect(rows.map((r) => r.relativePath)).to.not.include('src/index.ts');
  });

  it('collapseAll() collapses every expanded directory at once', async () => {
    model.setExpanded('src', true);
    model.setExpanded('src/auth', true);
    model.setExpanded('docs', true);
    model.collapseAll();
    expect(model.isExpanded('src')).to.be.false;
    expect(model.isExpanded('src/auth')).to.be.false;
    expect(model.isExpanded('docs')).to.be.false;
    const rows = await model.getVisibleRows();
    expect(rows.map((r) => r.relativePath).sort()).to.deep.equal(['README.md', 'docs', 'src'].sort());
  });

  it('collapseAll() also turns off "show selected only" so the collapse actually takes visible effect', async () => {
    await model.toggleFile('src/auth/login.ts', true);
    model.setShowSelectedOnly(true);
    expect(await collectVisiblePaths(model)).to.not.have.lengthOf(0);

    model.collapseAll();

    expect(model.getShowSelectedOnly()).to.be.false;
    const rows = await model.getVisibleRows();
    expect(rows.map((r) => r.relativePath).sort()).to.deep.equal(['README.md', 'docs', 'src'].sort());
    // Still selected — collapseAll() is a display-only reset, same as the
    // filter it just turned off.
    expect(model.getSelection()).to.deep.equal(['src/auth/login.ts']);
  });

  it('an active search filter auto-expands every returned directory, with no manual expand needed at all', async () => {
    // Nothing manually expanded — search alone should still surface the
    // full match chain, matching the old FileTreeProvider's "expanded by
    // default while a search is active" behavior.
    model.setSearchQuery(parseSearchQuery('login').query);
    const rows = await model.getVisibleRows();
    expect(rows.map((r) => r.relativePath).sort()).to.deep.equal(
      ['src', 'src/auth', 'src/auth/login.ts', 'src/auth/login.test.ts'].sort(),
    );
  });

  it('clearing the search reverts to whatever was actually manually expanded before searching', async () => {
    model.setExpanded('src', true);
    model.setSearchQuery(parseSearchQuery('login').query);
    model.setSearchQuery(undefined);
    const rows = await model.getVisibleRows();
    // 'src' stays expanded (the user really did expand it) but 'src/auth'
    // — only auto-expanded while the search was active — collapses back.
    expect(rows.map((r) => r.relativePath).sort()).to.deep.equal(
      ['README.md', 'docs', 'src', 'src/auth', 'src/index.ts', 'src/utils'].sort(),
    );
    expect(rows.map((r) => r.relativePath)).to.not.include('src/auth/login.ts');
  });
});

describe('FileTreeModel — background search index', () => {
  let root: string;
  let model: FileTreeModel;

  beforeEach(async () => {
    root = await makeSearchRoot();
  });
  afterEach(async () => {
    model.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('produces the same search results as the on-disk fallback once built', async () => {
    model = new FileTreeModel([fakeFolder(root, 0)]);
    await model.buildSearchIndex();
    model.setSearchQuery(parseSearchQuery('login').query);
    expect(await collectVisiblePaths(model)).to.deep.equal(
      ['src', 'src/auth', 'src/auth/login.ts', 'src/auth/login.test.ts'].sort(),
    );
  });

  it('skips smart-filter junk paths by default', async () => {
    await fs.mkdir(path.join(root, 'node_modules', 'some-pkg'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'some-pkg', 'login.js'), '// vendored');
    model = new FileTreeModel([fakeFolder(root, 0)]);
    await model.buildSearchIndex();
    model.setSearchQuery(parseSearchQuery('login').query);
    const visible = await collectVisiblePaths(model);
    expect(visible).to.not.include('node_modules/some-pkg/login.js');
    expect(visible).to.include('src/auth/login.ts');
  });

  it('includes junk paths when constructed with skipJunkInIndex disabled', async () => {
    await fs.mkdir(path.join(root, 'node_modules', 'some-pkg'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'some-pkg', 'login.js'), '// vendored');
    model = new FileTreeModel([fakeFolder(root, 0)], [], false);
    await model.buildSearchIndex();
    model.setSearchQuery(parseSearchQuery('login').query);
    expect(await collectVisiblePaths(model)).to.include('node_modules/some-pkg/login.js');
  });

  it('setSkipJunkInIndex(false) rebuilds and surfaces previously-skipped junk paths', async () => {
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'login.js'), '// vendored');
    model = new FileTreeModel([fakeFolder(root, 0)]);
    await model.buildSearchIndex();
    model.setSearchQuery(parseSearchQuery('login').query);
    expect(await collectVisiblePaths(model)).to.not.include('node_modules/login.js');

    await model.setSkipJunkInIndex(false);
    expect(await collectVisiblePaths(model)).to.include('node_modules/login.js');
  });

  it('excludes directories matching searchExcludeDirs, on top of the smart-filter defaults', async () => {
    // Deliberately NOT 'vendor' — that's already a smart-filter default, which
    // would leave this test passing even if searchExcludeDirs did nothing.
    await fs.mkdir(path.join(root, 'third-party'), { recursive: true });
    await fs.writeFile(path.join(root, 'third-party', 'login.php'), '// third party');
    model = new FileTreeModel([fakeFolder(root, 0)], [], true, 'third-party');
    await model.buildSearchIndex();
    model.setSearchQuery(parseSearchQuery('login').query);
    const visible = await collectVisiblePaths(model);
    expect(visible).to.not.include('third-party/login.php');
    expect(visible).to.include('src/auth/login.ts');
  });

  it('supports comma-separated, wildcard glob patterns', async () => {
    await fs.mkdir(path.join(root, 'generated'), { recursive: true });
    await fs.writeFile(path.join(root, 'generated', 'login.gen.ts'), '// generated');
    await fs.mkdir(path.join(root, 'pkg.egg-info'), { recursive: true });
    await fs.writeFile(path.join(root, 'pkg.egg-info', 'login-notes.txt'), 'login notes');
    model = new FileTreeModel([fakeFolder(root, 0)], [], true, 'generated,*.egg-info');
    await model.buildSearchIndex();
    model.setSearchQuery(parseSearchQuery('login').query);
    const visible = await collectVisiblePaths(model);
    expect(visible).to.not.include('generated/login.gen.ts');
    expect(visible).to.not.include('pkg.egg-info/login-notes.txt');
    expect(visible).to.include('src/auth/login.ts');
  });

  it('setSearchExcludeDirs() rebuilds and surfaces the newly-excluded/re-included paths', async () => {
    // Deliberately NOT named 'vendor' — that's already a smart-filter
    // default, which would make this ambiguous about which setting is
    // actually doing the excluding.
    await fs.mkdir(path.join(root, 'third-party'), { recursive: true });
    await fs.writeFile(path.join(root, 'third-party', 'login.php'), '// third party');
    model = new FileTreeModel([fakeFolder(root, 0)]);
    await model.buildSearchIndex();
    model.setSearchQuery(parseSearchQuery('login').query);
    expect(await collectVisiblePaths(model)).to.include('third-party/login.php');

    await model.setSearchExcludeDirs('third-party');
    expect(await collectVisiblePaths(model)).to.not.include('third-party/login.php');

    await model.setSearchExcludeDirs('');
    expect(await collectVisiblePaths(model)).to.include('third-party/login.php');
  });

  it('a stale in-flight build does not clobber a newer one', async () => {
    model = new FileTreeModel([fakeFolder(root, 0)]);
    const stale = model.buildSearchIndex();
    const fresh = model.buildSearchIndex();
    await Promise.all([stale, fresh]);
    model.setSearchQuery(parseSearchQuery('login').query);
    expect(await collectVisiblePaths(model)).to.deep.equal(
      ['src', 'src/auth', 'src/auth/login.ts', 'src/auth/login.test.ts'].sort(),
    );
  });

  it('prefixes index entries with the folder name in a multi-root workspace, matching on-disk rendering', async () => {
    const rootB = await makeSearchRoot();
    try {
      model = new FileTreeModel([fakeFolder(root, 0), fakeFolder(rootB, 1)]);
      await model.buildSearchIndex();
      model.setSearchQuery(parseSearchQuery('login').query);
      const rootName = path.basename(root);
      const rootBName = path.basename(rootB);
      const visible = await collectVisiblePaths(model);
      expect(visible).to.include(`${rootName}/src/auth/login.ts`);
      expect(visible).to.include(`${rootBName}/src/auth/login.ts`);
    } finally {
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });
});

describe('FileTreeModel — onDidToggleIndividualFile', () => {
  let root: string;
  let model: FileTreeModel;

  before(async () => {
    root = await makeRoot('aih-tree-individual-');
  });
  beforeEach(() => {
    model = new FileTreeModel([fakeFolder(root, 0)]);
  });
  afterEach(() => {
    model.dispose();
  });
  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('fires with the path and checked=true when a single file is ticked', async () => {
    const events: { relativePath: string; checked: boolean }[] = [];
    model.onDidToggleIndividualFile((e) => events.push(e));

    await model.toggleFile('src/index.ts', true);
    expect(events).to.deep.equal([{ relativePath: 'src/index.ts', checked: true }]);
  });

  it('fires with checked=false when a single file is unticked', async () => {
    const events: { relativePath: string; checked: boolean }[] = [];
    await model.toggleFile('src/index.ts', true);
    model.onDidToggleIndividualFile((e) => events.push(e));

    await model.toggleFile('src/index.ts', false);
    expect(events).to.deep.equal([{ relativePath: 'src/index.ts', checked: false }]);
  });

  it('does NOT fire when a whole directory is toggled — bulk-selecting a folder should stay subject to filters', async () => {
    const children = await model.getChildren(undefined);
    const srcDir = children.find((c) => c.name === 'src')!;

    const events: { relativePath: string; checked: boolean }[] = [];
    model.onDidToggleIndividualFile((e) => events.push(e));

    await model.toggleDirectory(srcDir.relativePath, true);
    expect(events).to.deep.equal([]);
    expect(model.getSelection()).to.deep.equal(['src/index.ts']);
  });
});

async function makeRelativeImportRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-tree-imports-rel-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'entry.ts'), `import Helper from './helper';\n`);
  await fs.writeFile(path.join(root, 'src', 'helper.ts'), `import Deep from './deep';\n`);
  await fs.writeFile(path.join(root, 'src', 'deep.ts'), `export const deep = true;\n`);
  return root;
}

/**
 * A fixture with both a plain relative import and a bare specifier resolved
 * through a tsconfig path alias, declared one `extends` hop away from the
 * config actually found (tsconfig.json at the workspace root extends
 * tsconfig.base.json, which is the one that actually declares baseUrl/paths).
 */
async function makeAliasImportRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-tree-imports-alias-'));
  await fs.mkdir(path.join(root, 'src', 'app'), { recursive: true });
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: './tsconfig.base.json' }));
  await fs.writeFile(
    path.join(root, 'tsconfig.base.json'),
    JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/app/*'] } },
    }),
  );
  await fs.writeFile(
    path.join(root, 'src', 'entry.ts'),
    `import Helper from './helper';\nimport Widget from '@app/widget';\n`,
  );
  await fs.writeFile(path.join(root, 'src', 'helper.ts'), `import Deep from './deep';\n`);
  await fs.writeFile(path.join(root, 'src', 'deep.ts'), `export const deep = true;\n`);
  await fs.writeFile(path.join(root, 'src', 'app', 'widget.ts'), `export const widget = true;\n`);
  return root;
}

describe('FileTreeModel — resolveImportClosure with plain relative imports', () => {
  let root: string;
  let model: FileTreeModel;

  beforeEach(async () => {
    root = await makeRelativeImportRoot();
    model = new FileTreeModel([fakeFolder(root, 0)]);
  });
  afterEach(async () => {
    model.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('resolves a direct relative import to its workspace-relative path', async () => {
    expect(await model.resolveImportClosure('src/entry.ts', false)).to.deep.equal(['src/helper.ts']);
  });

  it('non-recursive stops at direct imports, not the whole transitive graph', async () => {
    const closure = await model.resolveImportClosure('src/entry.ts', false);
    expect(closure).to.not.include('src/deep.ts');
  });

  it('recursive walks the whole transitive chain', async () => {
    expect(await model.resolveImportClosure('src/entry.ts', true)).to.deep.equal(['src/helper.ts', 'src/deep.ts']);
  });

  it('returns [] for a file with no imports', async () => {
    expect(await model.resolveImportClosure('src/deep.ts', true)).to.deep.equal([]);
  });
});

describe('FileTreeModel — resolveImportClosure with a tsconfig path alias', () => {
  let root: string;
  let model: FileTreeModel;

  beforeEach(async () => {
    root = await makeAliasImportRoot();
    model = new FileTreeModel([fakeFolder(root, 0)]);
  });
  afterEach(async () => {
    model.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('resolves a bare specifier through a tsconfig path alias declared one `extends` hop away', async () => {
    const closure = await model.resolveImportClosure('src/entry.ts', false);
    expect(closure).to.deep.equal(['src/helper.ts', 'src/app/widget.ts']);
  });

  it('follows the transitive graph through both the relative import and the aliased one', async () => {
    const closure = await model.resolveImportClosure('src/entry.ts', true);
    expect(closure.slice().sort()).to.deep.equal(['src/app/widget.ts', 'src/deep.ts', 'src/helper.ts'].sort());
  });

  it('never resolves a genuine bare package import (no alias match) into node_modules', async () => {
    await fs.writeFile(path.join(root, 'src', 'uses-pkg.ts'), `import x from 'left-pad';\n`);
    expect(await model.resolveImportClosure('src/uses-pkg.ts', true)).to.deep.equal([]);
  });
});

describe('FileTreeModel — toggleFile import cascade', () => {
  let root: string;
  let model: FileTreeModel;

  beforeEach(async () => {
    root = await makeAliasImportRoot();
    model = new FileTreeModel([fakeFolder(root, 0)]);
  });
  afterEach(async () => {
    model.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('getLookForImports/getImportsRecursive default to off/recursive, matching the plan', () => {
    expect(model.getLookForImports()).to.be.false;
    expect(model.getImportsRecursive()).to.be.true;
  });

  it('does not cascade when "look for imports" is off (the default)', async () => {
    await model.toggleFile('src/entry.ts', true);
    expect(model.getSelection()).to.deep.equal(['src/entry.ts']);
  });

  it('cascades the full transitive closure when on (recursive is the default)', async () => {
    await model.setLookForImports(true);
    await model.toggleFile('src/entry.ts', true);
    expect(model.getSelection().sort()).to.deep.equal(
      ['src/entry.ts', 'src/helper.ts', 'src/app/widget.ts', 'src/deep.ts'].sort(),
    );
  });

  it('cascades only direct imports when importsRecursive is turned off', async () => {
    await model.setLookForImports(true);
    await model.setImportsRecursive(false);
    await model.toggleFile('src/entry.ts', true);
    expect(model.getSelection().sort()).to.deep.equal(['src/entry.ts', 'src/helper.ts', 'src/app/widget.ts'].sort());
  });

  it('does not cascade for a non-JS/TS file even when "look for imports" is on', async () => {
    await fs.writeFile(path.join(root, 'README.md'), '# readme');
    await model.setLookForImports(true);
    await model.toggleFile('README.md', true);
    expect(model.getSelection()).to.deep.equal(['README.md']);
  });

  it('fires onDidChangeTree/onDidChangeSelection exactly once for the whole cascade, not once per resolved file', async () => {
    await model.setLookForImports(true);
    let treeFires = 0;
    let selectionFires = 0;
    model.onDidChangeTree(() => treeFires++);
    model.onDidChangeSelection(() => selectionFires++);

    await model.toggleFile('src/entry.ts', true);

    expect(treeFires).to.equal(1);
    expect(selectionFires).to.equal(1);
  });

  it('retroactively cascades already-selected JS/TS files when "look for imports" is turned on afterward', async () => {
    // Select the file BEFORE enabling the toggle — order shouldn't matter.
    await model.toggleFile('src/entry.ts', true);
    expect(model.getSelection()).to.deep.equal(['src/entry.ts']);

    await model.setLookForImports(true);
    expect(model.getSelection().sort()).to.deep.equal(
      ['src/entry.ts', 'src/helper.ts', 'src/app/widget.ts', 'src/deep.ts'].sort(),
    );
  });

  it('retroactively widens an already-cascaded selection when importsRecursive is turned on afterward', async () => {
    await model.setLookForImports(true);
    await model.setImportsRecursive(false);
    await model.toggleFile('src/entry.ts', true);
    expect(model.getSelection().sort()).to.deep.equal(['src/entry.ts', 'src/helper.ts', 'src/app/widget.ts'].sort());

    await model.setImportsRecursive(true);
    expect(model.getSelection().sort()).to.deep.equal(
      ['src/entry.ts', 'src/helper.ts', 'src/app/widget.ts', 'src/deep.ts'].sort(),
    );
  });

  it('does not re-fire selection/tree events when toggling a setting has nothing new to cascade', async () => {
    let treeFires = 0;
    let selectionFires = 0;
    model.onDidChangeTree(() => treeFires++);
    model.onDidChangeSelection(() => selectionFires++);

    // Nothing selected yet, so turning this on has nothing to cascade.
    await model.setLookForImports(true);

    expect(treeFires).to.equal(0);
    expect(selectionFires).to.equal(0);
  });

  it('narrowing "Follow imports recursively" off prunes cascade-added files no longer reachable, but keeps direct imports', async () => {
    await model.setLookForImports(true); // recursive is the default (true)
    await model.toggleFile('src/entry.ts', true);
    expect(model.getSelection().sort()).to.deep.equal(
      ['src/entry.ts', 'src/helper.ts', 'src/app/widget.ts', 'src/deep.ts'].sort(),
    );

    await model.setImportsRecursive(false);
    // src/deep.ts was only reachable transitively (entry -> helper -> deep);
    // src/helper.ts and src/app/widget.ts are still direct imports of entry.
    expect(model.getSelection().sort()).to.deep.equal(['src/entry.ts', 'src/helper.ts', 'src/app/widget.ts'].sort());
  });

  it('turning "look for imports" off entirely prunes every cascade-added file, keeping only the manual anchor', async () => {
    await model.setLookForImports(true);
    await model.toggleFile('src/entry.ts', true);
    expect(model.getSelection().sort()).to.deep.equal(
      ['src/entry.ts', 'src/helper.ts', 'src/app/widget.ts', 'src/deep.ts'].sort(),
    );

    await model.setLookForImports(false);
    expect(model.getSelection()).to.deep.equal(['src/entry.ts']);
  });

  it('manually checking a cascade-added file protects it from later pruning', async () => {
    await model.setLookForImports(true);
    await model.toggleFile('src/entry.ts', true);
    // src/deep.ts arrived only via the cascade — now click it directly too.
    await model.toggleFile('src/deep.ts', true);

    await model.setLookForImports(false);
    // Everything else the cascade added is gone; deep.ts survives because it
    // was manually clicked, even though it originally came from the cascade.
    expect(model.getSelection().sort()).to.deep.equal(['src/deep.ts', 'src/entry.ts'].sort());
  });

  it('unchecking a manual anchor only prunes cascade-added files no longer reachable from any remaining anchor', async () => {
    // A second manually-selected file that independently imports helper.ts,
    // so helper.ts stays justified even after entry.ts is unchecked.
    await fs.writeFile(path.join(root, 'src', 'other.ts'), `import Helper from './helper';\n`);

    await model.setLookForImports(true);
    await model.setImportsRecursive(false); // keep this scenario to direct imports only
    await model.toggleFile('src/entry.ts', true); // -> entry (manual), helper + widget (cascade)
    await model.toggleFile('src/other.ts', true); // -> other (manual); also imports helper, already selected
    expect(model.getSelection().sort()).to.deep.equal(
      ['src/entry.ts', 'src/other.ts', 'src/helper.ts', 'src/app/widget.ts'].sort(),
    );

    await model.toggleFile('src/entry.ts', false);
    // widget.ts was only reachable via entry.ts, now gone. helper.ts is still
    // reachable via other.ts, so it survives despite never being clicked directly.
    expect(model.getSelection().sort()).to.deep.equal(['src/other.ts', 'src/helper.ts'].sort());
  });

  it('bulk directory selection is always manual — pruning never touches files added via toggleDirectory', async () => {
    await model.setLookForImports(true);
    await model.toggleDirectory('src', true);
    const fullSelection = model.getSelection().sort();
    expect(fullSelection).to.include.members(['src/entry.ts', 'src/helper.ts', 'src/deep.ts', 'src/app/widget.ts']);

    await model.setLookForImports(false);
    // Nothing was cascade-added (directory selection never triggers the
    // cascade), so nothing gets pruned.
    expect(model.getSelection().sort()).to.deep.equal(fullSelection);
  });
});
