/**
 * Git diff service. Shells out to the `git` CLI (never a shell string —
 * always execFile with an argument array) to collect uncommitted/staged
 * changes across every git repo in the workspace.
 *
 * Two layers:
 *   - readGitDiffForRepo: single-repo primitive, runs `git diff` in one cwd.
 *   - readGitDiffForWorkspace: enumerates workspace folders, resolves each
 *     to its repo root (if any) — or, if a folder isn't a repo itself,
 *     scans its immediate subdirectories for nested repos (covers opening
 *     a plain "folder of projects" as a single workspace root, not just
 *     true VS Code multi-root workspaces) — dedupes repos reached more
 *     than one way, and merges the per-repo results.
 */

import { execFile as execFileCb } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { DEFAULT_SMART_FILTER_PATTERNS } from '../core/filter';
import type { DiffChangeType, DiffFileChange, DiffScope, GitDiffResult } from '../core/types';

const execFile = promisify(execFileCb);

// Directory names to skip when scanning for nested repos one level down —
// reuses the same junk-folder list the file-selection smart filter uses.
const SKIP_DIR_NAMES = new Set(
  DEFAULT_SMART_FILTER_PATTERNS.filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1)),
);

interface RepoDiffResult {
  files: DiffFileChange[];
  error?: 'error';
  errorDetail?: string;
}

function isEnoent(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === 'ENOENT';
}

function stderrOf(e: unknown): string {
  const err = e as NodeJS.ErrnoException & { stderr?: string };
  return err.stderr?.trim() || err.message || String(e);
}

async function runOneDiff(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', ['diff', '--no-color', ...args], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024 * 32,
  });
  return stdout;
}

const DIFF_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/;

/**
 * Split raw `git diff` stdout into per-file chunks and classify each one.
 */
function parseDiffOutput(raw: string, staged: boolean, repoLabel: string): DiffFileChange[] {
  if (!raw.trim()) {
    return [];
  }

  const lines = raw.split('\n');
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current.length > 0) {
        chunks.push(current);
      }
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks.map((chunkLines) => parseChunk(chunkLines, staged, repoLabel));
}

function parseChunk(lines: string[], staged: boolean, repoLabel: string): DiffFileChange {
  const headerMatch = DIFF_HEADER_RE.exec(lines[0] ?? '');
  const aPath = headerMatch?.[1] ?? '';
  const bPath = headerMatch?.[2] ?? aPath;

  let changeType: DiffChangeType = 'modified';
  let oldPath: string | undefined;
  let isBinary = false;

  // Header lines (mode/rename/binary markers) only appear before the first
  // hunk or file-marker line — stop scanning once real diff content starts.
  for (const line of lines.slice(1)) {
    if (line.startsWith('--- ') || line.startsWith('@@ ')) {
      break;
    }
    if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
      isBinary = true;
      break;
    }
    if (line.startsWith('new file mode')) {
      changeType = 'added';
    } else if (line.startsWith('deleted file mode')) {
      changeType = 'deleted';
    } else if (line.startsWith('rename from ')) {
      changeType = 'renamed';
      oldPath = line.slice('rename from '.length);
    }
  }

  return {
    relativePath: bPath,
    oldPath,
    changeType,
    patch: lines.join('\n'),
    isBinary,
    staged,
    repoLabel,
  };
}

/**
 * Run `git diff` in a single repo for the given scope. Never throws for
 * ordinary git failures (e.g. not a repo) — only propagates ENOENT (git
 * binary missing), which callers treat as a workspace-wide condition.
 */
export async function readGitDiffForRepo(
  repoRoot: string,
  scope: DiffScope,
  repoLabel: string = path.basename(repoRoot),
): Promise<RepoDiffResult> {
  const variants: { args: string[]; staged: boolean }[] = [];
  if (scope === 'working' || scope === 'both') {
    variants.push({ args: [], staged: false });
  }
  if (scope === 'staged' || scope === 'both') {
    variants.push({ args: ['--cached'], staged: true });
  }

  try {
    const outputs = await Promise.all(variants.map((v) => runOneDiff(repoRoot, v.args)));
    const files = outputs.flatMap((stdout, i) => parseDiffOutput(stdout, variants[i].staged, repoLabel));
    return { files };
  } catch (e) {
    if (isEnoent(e)) {
      throw e;
    }
    return { files: [], error: 'error', errorDetail: stderrOf(e) };
  }
}

/**
 * Resolve a directory to its git repo root, or undefined if it isn't one.
 * Propagates ENOENT (git binary missing) — that's a workspace-wide
 * condition, not a per-directory one.
 */
async function resolveRepoToplevel(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
    return stdout.trim();
  } catch (e) {
    if (isEnoent(e)) {
      throw e;
    }
    return undefined;
  }
}

/**
 * A directory that isn't a repo itself might be a plain folder containing
 * several project folders (e.g. a workspace root opened one level above
 * where each project's .git actually lives). Check immediate subdirectories
 * only — not a full recursive crawl, which would be expensive and could
 * pick up unrelated nested repos (e.g. inside dependency folders).
 */
async function findNestedRepoRoots(dir: string): Promise<{ toplevel: string; label: string }[]> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: { toplevel: string; label: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIR_NAMES.has(entry.name)) {
      continue;
    }
    const toplevel = await resolveRepoToplevel(path.join(dir, entry.name));
    if (toplevel) {
      found.push({ toplevel, label: entry.name });
    }
  }
  return found;
}

/**
 * Collect git diffs across every workspace folder. A folder that isn't a
 * repo itself is checked one level down for nested repos before being
 * recorded in `reposWithNoGit` — this is informational, not an error,
 * since workspaces routinely mix git and non-git folders. Repos reached
 * more than one way (e.g. two workspace folders pointing into the same
 * repo) are only diffed once.
 */
export async function readGitDiffForWorkspace(
  folders: { name: string; path: string }[],
  scope: DiffScope,
): Promise<GitDiffResult> {
  const reposWithNoGit: string[] = [];
  const repoRootToLabel = new Map<string, string>();

  try {
    for (const folder of folders) {
      const toplevel = await resolveRepoToplevel(folder.path);
      if (toplevel) {
        if (!repoRootToLabel.has(toplevel)) {
          repoRootToLabel.set(toplevel, folder.name);
        }
        continue;
      }

      const nested = await findNestedRepoRoots(folder.path);
      if (nested.length === 0) {
        reposWithNoGit.push(folder.name);
        continue;
      }
      for (const repo of nested) {
        if (!repoRootToLabel.has(repo.toplevel)) {
          repoRootToLabel.set(repo.toplevel, repo.label);
        }
      }
    }
  } catch (e) {
    if (isEnoent(e)) {
      return { scope, files: [], reposWithNoGit: [], error: 'git-not-found' };
    }
    throw e;
  }

  if (repoRootToLabel.size === 0) {
    return { scope, files: [], reposWithNoGit, error: 'no-repos-found' };
  }

  const perRepo = await Promise.all(
    Array.from(repoRootToLabel.entries()).map(([repoRoot, label]) =>
      readGitDiffForRepo(repoRoot, scope, label),
    ),
  );

  return {
    scope,
    files: perRepo.flatMap((r) => r.files),
    reposWithNoGit,
  };
}
