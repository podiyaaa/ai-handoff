/**
 * Branch/commit diff service, for generating a handoff from a PR's full
 * changed-file set (as opposed to `git-diff-reader.ts`'s working/staged
 * hunks). Shells out to the `git` CLI (never a shell string — always
 * execFile with an argument array), following the same conventions as
 * `git-diff-reader.ts`: errors are swallowed into a result object except
 * ENOENT (the git binary itself missing), which propagates as a
 * workspace-wide condition.
 *
 * Two primitives:
 *   - listLocalBranches: branch names for a repo, to populate the two ref
 *     dropdowns. Keeping branches up to date (e.g. `git fetch`) is the
 *     user's responsibility — this never fetches.
 *   - listChangedFilesBetweenRefs: the file list for a three-dot
 *     (merge-base) diff between two refs — `git diff base...compare`,
 *     matching what GitHub shows reviewers on a PR's "Files changed" tab.
 *     Deleted files are dropped before returning, since there's nothing to
 *     show for them at `compareRef`.
 *
 * Full file content is read separately via `readFileAtRef()`, from the
 * compare ref's git blob (`git show ref:path`) rather than the filesystem —
 * neither ref is guaranteed to be the current checkout.
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import type { RefDiffChangeType, RefDiffFileEntry } from '../core/types';

const execFile = promisify(execFileCb);

const MAX_BUFFER = 1024 * 1024 * 32;

function isEnoent(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * List local branch names in a repo. Never fetches — reflects whatever the
 * user already has locally. Never throws for ordinary git failures; only
 * propagates ENOENT (git binary missing).
 */
export async function listLocalBranches(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFile(
      'git',
      ['branch', '--format=%(refname:short)'],
      { cwd: repoRoot, maxBuffer: MAX_BUFFER },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (e) {
    if (isEnoent(e)) {
      throw e;
    }
    return [];
  }
}

const STATUS_RE = /^([AMD]|R\d*)\t([^\t]+)(?:\t([^\t]+))?$/;

/**
 * Parse one `git diff --name-status` line into a change entry, or undefined
 * for a deleted file (dropped by the caller) or an unparseable line.
 */
function parseNameStatusLine(line: string): (RefDiffFileEntry & { deleted?: boolean }) | undefined {
  const match = STATUS_RE.exec(line);
  if (!match) {
    return undefined;
  }
  const [, code, first, second] = match;

  if (code === 'D') {
    return { relativePath: first, changeType: 'modified', deleted: true };
  }
  if (code === 'A') {
    return { relativePath: first, changeType: 'added' };
  }
  if (code.startsWith('R')) {
    // Rename lines are "R<similarity>\told\tnew".
    const changeType: RefDiffChangeType = 'renamed';
    return { relativePath: second ?? first, oldPath: first, changeType };
  }
  // 'M' and anything else (e.g. a type-change code we don't special-case)
  // are treated as a plain modification.
  return { relativePath: first, changeType: 'modified' };
}

/**
 * List files that differ between two refs, using a three-dot (merge-base)
 * diff — `git diff base...compare` — matching GitHub's PR "Files changed"
 * view rather than a raw two-dot comparison. Deleted files are excluded:
 * there's nothing to show for them at `compareRef`.
 *
 * Never throws for ordinary git failures (e.g. a ref that doesn't resolve)
 * — returns an empty list, letting the caller surface `'invalid-refs'`.
 * Only propagates ENOENT (git binary missing).
 */
export async function listChangedFilesBetweenRefs(
  repoRoot: string,
  baseRef: string,
  compareRef: string,
): Promise<RefDiffFileEntry[]> {
  try {
    const { stdout } = await execFile(
      'git',
      ['diff', '--no-color', '--name-status', `${baseRef}...${compareRef}`],
      { cwd: repoRoot, maxBuffer: MAX_BUFFER },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(parseNameStatusLine)
      .filter((entry): entry is RefDiffFileEntry & { deleted?: boolean } => entry !== undefined)
      .filter((entry) => !entry.deleted)
      .map(({ relativePath, oldPath, changeType }) => ({ relativePath, oldPath, changeType }));
  } catch (e) {
    if (isEnoent(e)) {
      throw e;
    }
    return [];
  }
}

/**
 * Read a file's content at a specific ref, straight from git's object
 * store — correct regardless of what's currently checked out. Git's
 * plumbing output always uses forward slashes for paths, so no separator
 * translation is needed for `relativePath` here.
 *
 * Throws on failure (e.g. the path doesn't exist at that ref) — callers
 * treat a single file's read failure as a per-file skip, not fatal to the
 * whole generation.
 */
export async function readFileAtRef(
  repoRoot: string,
  ref: string,
  relativePath: string,
): Promise<Buffer> {
  const { stdout } = await execFile('git', ['show', `${ref}:${relativePath}`], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}
