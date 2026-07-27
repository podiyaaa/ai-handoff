import { expect } from 'chai';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readGitDiffForRepo, readGitDiffForWorkspace, RepoRootCache } from '../../services/git-diff-reader';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd });
}

function initRepoAt(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
}

async function initRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-git-'));
  initRepoAt(root);
  return root;
}

async function commitAll(root: string, message = 'init'): Promise<void> {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
}

describe('readGitDiffForRepo', () => {
  let root: string;
  beforeEach(async () => {
    root = await initRepo();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports a modified file in working scope', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'hello\n');
    await commitAll(root);
    await fs.writeFile(path.join(root, 'a.txt'), 'hello world\n');

    const result = await readGitDiffForRepo(root, 'working');
    expect(result.files).to.have.lengthOf(1);
    expect(result.files[0].relativePath).to.equal('a.txt');
    expect(result.files[0].changeType).to.equal('modified');
    expect(result.files[0].staged).to.be.false;
    expect(result.files[0].patch).to.include('hello world');
  });

  it('reports a staged-only change with scope "staged" and not "working"', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'hello\n');
    await commitAll(root);
    await fs.writeFile(path.join(root, 'a.txt'), 'hello staged\n');
    git(root, ['add', 'a.txt']);

    const workingResult = await readGitDiffForRepo(root, 'working');
    expect(workingResult.files).to.have.lengthOf(0);

    const stagedResult = await readGitDiffForRepo(root, 'staged');
    expect(stagedResult.files).to.have.lengthOf(1);
    expect(stagedResult.files[0].staged).to.be.true;
  });

  it('scope "both" returns staged and unstaged files correctly tagged', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
    await fs.writeFile(path.join(root, 'b.txt'), 'b\n');
    await commitAll(root);
    await fs.writeFile(path.join(root, 'a.txt'), 'a changed\n');
    git(root, ['add', 'a.txt']);
    await fs.writeFile(path.join(root, 'b.txt'), 'b changed\n');

    const result = await readGitDiffForRepo(root, 'both');
    expect(result.files).to.have.lengthOf(2);
    const a = result.files.find((f) => f.relativePath === 'a.txt');
    const b = result.files.find((f) => f.relativePath === 'b.txt');
    expect(a?.staged).to.be.true;
    expect(b?.staged).to.be.false;
  });

  it('detects an added file', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
    await commitAll(root);
    await fs.writeFile(path.join(root, 'new.txt'), 'new content\n');
    git(root, ['add', 'new.txt']);

    const result = await readGitDiffForRepo(root, 'staged');
    expect(result.files).to.have.lengthOf(1);
    expect(result.files[0].changeType).to.equal('added');
    expect(result.files[0].relativePath).to.equal('new.txt');
  });

  it('detects a deleted file', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
    await commitAll(root);
    await fs.rm(path.join(root, 'a.txt'));

    const result = await readGitDiffForRepo(root, 'working');
    expect(result.files).to.have.lengthOf(1);
    expect(result.files[0].changeType).to.equal('deleted');
    expect(result.files[0].relativePath).to.equal('a.txt');
  });

  it('detects a renamed file and captures oldPath', async () => {
    await fs.writeFile(path.join(root, 'old.txt'), 'x'.repeat(50) + '\n');
    await commitAll(root);
    await fs.rename(path.join(root, 'old.txt'), path.join(root, 'new.txt'));
    git(root, ['add', '-A']);

    const result = await readGitDiffForRepo(root, 'staged');
    expect(result.files).to.have.lengthOf(1);
    expect(result.files[0].changeType).to.equal('renamed');
    expect(result.files[0].oldPath).to.equal('old.txt');
    expect(result.files[0].relativePath).to.equal('new.txt');
  });

  it('detects a binary file diff without inlining content', async () => {
    await fs.writeFile(path.join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    await commitAll(root);
    await fs.writeFile(path.join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]));

    const result = await readGitDiffForRepo(root, 'working');
    expect(result.files).to.have.lengthOf(1);
    expect(result.files[0].isBinary).to.be.true;
    expect(result.files[0].patch).to.include('Binary files');
  });

  it('handles a repo with no commits yet (unborn HEAD) for staged scope', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
    git(root, ['add', 'a.txt']);

    const result = await readGitDiffForRepo(root, 'staged');
    expect(result.files).to.have.lengthOf(1);
    expect(result.files[0].changeType).to.equal('added');
  });

  it('returns no files and no error for a clean working tree', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
    await commitAll(root);

    const result = await readGitDiffForRepo(root, 'both');
    expect(result.files).to.have.lengthOf(0);
    expect(result.error).to.be.undefined;
  });
});

describe('readGitDiffForWorkspace', () => {
  it('merges diffs from multiple repos, tagging each file with its repoLabel', async () => {
    const repoA = await initRepo();
    const repoB = await initRepo();
    try {
      await fs.writeFile(path.join(repoA, 'a.txt'), 'a\n');
      await commitAll(repoA);
      await fs.writeFile(path.join(repoA, 'a.txt'), 'a changed\n');

      await fs.writeFile(path.join(repoB, 'b.txt'), 'b\n');
      await commitAll(repoB);
      await fs.writeFile(path.join(repoB, 'b.txt'), 'b changed\n');

      const result = await readGitDiffForWorkspace(
        [
          { name: 'service-a', path: repoA },
          { name: 'service-b', path: repoB },
        ],
        'working',
      );
      expect(result.files).to.have.lengthOf(2);
      expect(result.reposWithNoGit).to.have.lengthOf(0);
      expect(result.error).to.be.undefined;
      const labels = result.files.map((f) => f.repoLabel).sort();
      expect(labels).to.deep.equal(['service-a', 'service-b']);
    } finally {
      await fs.rm(repoA, { recursive: true, force: true });
      await fs.rm(repoB, { recursive: true, force: true });
    }
  });

  it('records non-git folders in reposWithNoGit without erroring', async () => {
    const repoA = await initRepo();
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-plain-'));
    try {
      await fs.writeFile(path.join(repoA, 'a.txt'), 'a\n');
      await commitAll(repoA);
      await fs.writeFile(path.join(repoA, 'a.txt'), 'a changed\n');

      const result = await readGitDiffForWorkspace(
        [
          { name: 'repo', path: repoA },
          { name: 'plain', path: plain },
        ],
        'working',
      );
      expect(result.error).to.be.undefined;
      expect(result.reposWithNoGit).to.deep.equal(['plain']);
      expect(result.files).to.have.lengthOf(1);
    } finally {
      await fs.rm(repoA, { recursive: true, force: true });
      await fs.rm(plain, { recursive: true, force: true });
    }
  });

  it('returns error "no-repos-found" when no workspace folder is a git repo', async () => {
    const plainA = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-plain-'));
    const plainB = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-plain-'));
    try {
      const result = await readGitDiffForWorkspace(
        [
          { name: 'a', path: plainA },
          { name: 'b', path: plainB },
        ],
        'working',
      );
      expect(result.error).to.equal('no-repos-found');
      expect(result.files).to.have.lengthOf(0);
    } finally {
      await fs.rm(plainA, { recursive: true, force: true });
      await fs.rm(plainB, { recursive: true, force: true });
    }
  });

  it('only diffs a repo once when two workspace folders resolve into it', async () => {
    const repoA = await initRepo();
    try {
      await fs.mkdir(path.join(repoA, 'sub'));
      await fs.writeFile(path.join(repoA, 'sub', 'a.txt'), 'a\n');
      await commitAll(repoA);
      await fs.writeFile(path.join(repoA, 'sub', 'a.txt'), 'a changed\n');

      const result = await readGitDiffForWorkspace(
        [
          { name: 'root', path: repoA },
          { name: 'sub', path: path.join(repoA, 'sub') },
        ],
        'working',
      );
      expect(result.files).to.have.lengthOf(1);
    } finally {
      await fs.rm(repoA, { recursive: true, force: true });
    }
  });

  it('discovers nested repos when the workspace folder itself is not a repo', async () => {
    // Reproduces opening a plain "folder of projects" as a single-folder
    // workspace, where the folder itself has no .git but its immediate
    // children (service-a, service-b) are each their own repo.
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-parent-'));
    try {
      const serviceA = path.join(parent, 'service-a');
      const serviceB = path.join(parent, 'service-b');
      await fs.mkdir(serviceA);
      await fs.mkdir(serviceB);
      initRepoAt(serviceA);
      initRepoAt(serviceB);

      await fs.writeFile(path.join(serviceA, 'a.txt'), 'a\n');
      await commitAll(serviceA);
      await fs.writeFile(path.join(serviceA, 'a.txt'), 'a changed\n');

      await fs.writeFile(path.join(serviceB, 'b.txt'), 'b\n');
      await commitAll(serviceB);
      await fs.writeFile(path.join(serviceB, 'b.txt'), 'b changed\n');

      const result = await readGitDiffForWorkspace(
        [{ name: path.basename(parent), path: parent }],
        'working',
      );
      expect(result.error).to.be.undefined;
      expect(result.files).to.have.lengthOf(2);
      const labels = result.files.map((f) => f.repoLabel).sort();
      expect(labels).to.deep.equal(['service-a', 'service-b']);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it('does not descend into node_modules or dotfolders when scanning for nested repos', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-parent-'));
    try {
      const junk = path.join(parent, 'node_modules', 'some-lib');
      await fs.mkdir(junk, { recursive: true });
      initRepoAt(junk);

      const hidden = path.join(parent, '.hidden-repo');
      await fs.mkdir(hidden, { recursive: true });
      initRepoAt(hidden);

      const result = await readGitDiffForWorkspace(
        [{ name: path.basename(parent), path: parent }],
        'working',
      );
      expect(result.error).to.equal('no-repos-found');
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it('discovers repos nested more than one level down (a category folder containing project folders)', async () => {
    // Mirrors the reported bug: workspace-root/03-name-collision/service-a/.git
    // — the repo is two levels below the workspace folder, not one.
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-parent-'));
    try {
      const serviceA = path.join(parent, '03-name-collision', 'service-a');
      const serviceB = path.join(parent, '03-name-collision', 'service-b');
      await fs.mkdir(serviceA, { recursive: true });
      await fs.mkdir(serviceB, { recursive: true });
      initRepoAt(serviceA);
      initRepoAt(serviceB);

      await fs.writeFile(path.join(serviceA, 'a.txt'), 'a\n');
      await commitAll(serviceA);
      await fs.writeFile(path.join(serviceA, 'a.txt'), 'a changed\n');

      const result = await readGitDiffForWorkspace(
        [{ name: path.basename(parent), path: parent }],
        'working',
      );
      expect(result.error).to.be.undefined;
      expect(result.files).to.have.lengthOf(1);
      expect(result.files[0].repoLabel).to.equal('service-a');
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it('stops at the first repo found on a branch, without looking for repos nested inside it', async () => {
    // If the walk incorrectly kept recursing past a found repo, inner-repo
    // would surface as its own independently-discovered (and diffed) repo
    // alongside outer-repo — this asserts it does not.
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-parent-'));
    try {
      const outer = path.join(parent, 'outer-repo');
      const inner = path.join(outer, 'vendored', 'inner-repo');
      await fs.mkdir(inner, { recursive: true });
      initRepoAt(outer);
      initRepoAt(inner);

      // `git add -A` would refuse (fatal) on an embedded repo with no commit
      // checked out yet, so add the one file explicitly instead of `-A`.
      await fs.writeFile(path.join(outer, 'a.txt'), 'a\n');
      git(outer, ['add', 'a.txt']);
      git(outer, ['commit', '-q', '-m', 'init']);
      await fs.writeFile(path.join(outer, 'a.txt'), 'a changed\n');

      const result = await readGitDiffForWorkspace(
        [{ name: path.basename(parent), path: parent }],
        'working',
      );
      expect(result.error).to.be.undefined;
      const labels = result.files.map((f) => f.repoLabel).sort();
      expect(labels).to.deep.equal(['outer-repo']);
      expect(result.files.map((f) => f.relativePath)).to.deep.equal(['a.txt']);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});

describe('RepoRootCache', () => {
  it('memoizes repo discovery per folder — a repo added after the first call is not found until invalidated', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-cache-'));
    try {
      const cache = new RepoRootCache();
      const folder = { name: path.basename(parent), path: parent };

      const before = await readGitDiffForWorkspace([folder], 'working', cache);
      expect(before.error).to.equal('no-repos-found');

      // A repo appears after the first (cached) resolution...
      const serviceA = path.join(parent, 'service-a');
      await fs.mkdir(serviceA, { recursive: true });
      initRepoAt(serviceA);
      await fs.writeFile(path.join(serviceA, 'a.txt'), 'a\n');
      await commitAll(serviceA);
      await fs.writeFile(path.join(serviceA, 'a.txt'), 'a changed\n');

      // ...still not found while the cache is warm...
      const stillCached = await readGitDiffForWorkspace([folder], 'working', cache);
      expect(stillCached.error).to.equal('no-repos-found');

      // ...but shows up once invalidated.
      cache.invalidate();
      const afterInvalidate = await readGitDiffForWorkspace([folder], 'working', cache);
      expect(afterInvalidate.error).to.be.undefined;
      expect(afterInvalidate.files).to.have.lengthOf(1);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it('without a cache, readGitDiffForWorkspace re-resolves from disk every call', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-nocache-'));
    try {
      const folder = { name: path.basename(parent), path: parent };
      const before = await readGitDiffForWorkspace([folder], 'working');
      expect(before.error).to.equal('no-repos-found');

      const serviceA = path.join(parent, 'service-a');
      await fs.mkdir(serviceA, { recursive: true });
      initRepoAt(serviceA);
      await fs.writeFile(path.join(serviceA, 'a.txt'), 'a\n');
      await commitAll(serviceA);
      await fs.writeFile(path.join(serviceA, 'a.txt'), 'a changed\n');

      const after = await readGitDiffForWorkspace([folder], 'working');
      expect(after.error).to.be.undefined;
      expect(after.files).to.have.lengthOf(1);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
