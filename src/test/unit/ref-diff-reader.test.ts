import { expect } from 'chai';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { listChangedFilesBetweenRefs, listLocalBranches, readFileAtRef } from '../../services/ref-diff-reader';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd });
}

async function initRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-refdiff-'));
  git(root, ['init', '-q']);
  // Pin the initial branch name explicitly — relying on git's configured
  // default (which varies by environment/version) would make these
  // ref-name-sensitive tests flaky.
  git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  return root;
}

async function commitAll(root: string, message = 'init'): Promise<void> {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
}

describe('listLocalBranches', () => {
  it('lists local branch names', async () => {
    const root = await initRepo();
    try {
      await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
      await commitAll(root);
      git(root, ['branch', 'feature']);

      const branches = await listLocalBranches(root);
      expect(branches.sort()).to.deep.equal(['feature', 'main']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('returns an empty list for a repo with no commits yet', async () => {
    const root = await initRepo();
    try {
      const branches = await listLocalBranches(root);
      expect(branches).to.deep.equal([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('listChangedFilesBetweenRefs', () => {
  it('detects added, modified, and renamed files between two branches', async () => {
    const root = await initRepo();
    try {
      await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
      await fs.writeFile(path.join(root, 'old.txt'), 'x'.repeat(50) + '\n');
      await commitAll(root);
      git(root, ['checkout', '-b', 'feature']);

      await fs.writeFile(path.join(root, 'a.txt'), 'a changed\n');
      await fs.writeFile(path.join(root, 'new.txt'), 'new\n');
      await fs.rename(path.join(root, 'old.txt'), path.join(root, 'renamed.txt'));
      await commitAll(root, 'feature work');

      const entries = await listChangedFilesBetweenRefs(root, 'main', 'feature');
      const byPath = new Map(entries.map((e) => [e.relativePath, e]));

      expect(entries).to.have.lengthOf(3);
      expect(byPath.get('a.txt')?.changeType).to.equal('modified');
      expect(byPath.get('new.txt')?.changeType).to.equal('added');
      expect(byPath.get('renamed.txt')?.changeType).to.equal('renamed');
      expect(byPath.get('renamed.txt')?.oldPath).to.equal('old.txt');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('excludes deleted files entirely', async () => {
    const root = await initRepo();
    try {
      await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
      await fs.writeFile(path.join(root, 'b.txt'), 'b\n');
      await commitAll(root);
      git(root, ['checkout', '-b', 'feature']);
      await fs.rm(path.join(root, 'b.txt'));
      await commitAll(root, 'delete b');

      const entries = await listChangedFilesBetweenRefs(root, 'main', 'feature');
      expect(entries).to.have.lengthOf(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('uses three-dot (merge-base) semantics — unrelated commits that later land on base are excluded', async () => {
    const root = await initRepo();
    try {
      await fs.writeFile(path.join(root, 'shared.txt'), 'shared\n');
      await commitAll(root, 'common ancestor');

      git(root, ['checkout', '-b', 'feature']);
      await fs.writeFile(path.join(root, 'feature-file.txt'), 'feature\n');
      await commitAll(root, 'feature work');

      git(root, ['checkout', 'main']);
      await fs.writeFile(path.join(root, 'main-only.txt'), 'main only\n');
      await commitAll(root, 'unrelated main work');

      const entries = await listChangedFilesBetweenRefs(root, 'main', 'feature');
      // A raw two-dot diff (main..feature) would also show main-only.txt as
      // "removed" on the feature side — three-dot must not, since it only
      // reflects what feature itself did since diverging from main.
      expect(entries.map((e) => e.relativePath)).to.deep.equal(['feature-file.txt']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('readFileAtRef', () => {
  it('reads a file\'s content at a specific ref, independent of what is checked out', async () => {
    const root = await initRepo();
    try {
      await fs.writeFile(path.join(root, 'a.txt'), 'main content\n');
      await commitAll(root);
      git(root, ['checkout', '-b', 'feature']);
      await fs.writeFile(path.join(root, 'a.txt'), 'feature content\n');
      await commitAll(root, 'feature change');
      git(root, ['checkout', 'main']);
      // Working tree now shows main's content — readFileAtRef must still
      // return feature's, since it reads from git's object store directly.

      const buffer = await readFileAtRef(root, 'feature', 'a.txt');
      expect(buffer.toString('utf-8')).to.equal('feature content\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('throws when the path does not exist at that ref', async () => {
    const root = await initRepo();
    try {
      await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
      await commitAll(root);

      let threw = false;
      try {
        await readFileAtRef(root, 'main', 'missing.txt');
      } catch {
        threw = true;
      }
      expect(threw).to.be.true;
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
