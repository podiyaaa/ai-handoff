/**
 * Handoff generator — the top-level orchestrator.
 *
 * Pipeline:
 *   selected paths
 *      ↓ stat each (size for filter)
 *      ↓ FilterChain.decide(...) → keep | skip(reason)
 *   surviving paths
 *      ↓ readFile(...)  → text | binary | error
 *   included files + skipped list
 *      ↓ formatHandoff(...)
 *   HandoffResult
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { FilterChain, formatBytes } from '../core/filter';
import { formatDiffSection, formatHandoff } from '../core/formatter';
import { estimateTokens } from '../core/token-estimator';
import { buildTreeForFormat } from '../core/tree-builder';
import type {
  HandoffOptions,
  HandoffResult,
  IncludedFile,
  LineRange,
  SelectedFile,
  SkippedFile,
} from '../core/types';
import { readFile } from './file-reader';
import { readGitDiffForWorkspace, RepoRootCache } from './git-diff-reader';

/**
 * Read .gitignore from the workspace root (best-effort).
 */
export async function readGitignore(workspaceRoot: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(workspaceRoot, '.gitignore'), 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Expand any directory paths in the selection to their constituent files,
 * recursing into sub-directories. Files already present in the list are
 * kept as-is. Duplicate paths (e.g. a dir AND one of its files) are
 * deduplicated by relative path, keeping the first occurrence.
 */
async function expandToFiles(selected: SelectedFile[]): Promise<SelectedFile[]> {
  const seen = new Set<string>();
  const out: SelectedFile[] = [];

  async function processPath(
    relativePath: string,
    absolutePath: string,
    lineRange: LineRange | undefined,
  ): Promise<void> {
    if (seen.has(relativePath)) {
      return;
    }
    let stat: import('fs').Stats;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      // Stat failed — pass through to the main loop which will record the error.
      seen.add(relativePath);
      out.push({ relativePath, absolutePath, lineRange });
      return;
    }
    if (stat.isDirectory()) {
      // Recursively expand to child files — this is what makes right-click on
      // a folder work in the handoff generator.
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(absolutePath, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childAbs = path.join(absolutePath, entry.name);
        // Build child relative path from parent's relative path so this works
        // correctly for files from any workspace folder, not just the primary one.
        const childRel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        // lineRange never applies to a directory's expanded children — it's
        // only meaningful for the single file it was actually captured on.
        await processPath(childRel, childAbs, undefined);
      }
    } else if (stat.isFile()) {
      seen.add(relativePath);
      out.push({ relativePath, absolutePath, lineRange });
    }
    // Symlinks to neither file nor dir are silently dropped.
  }

  for (const sel of selected) {
    await processPath(sel.relativePath, sel.absolutePath, sel.lineRange);
  }
  return out;
}

/**
 * Run the full handoff pipeline.
 */
export async function generateHandoff(
  selected: SelectedFile[],
  options: HandoffOptions,
  workspaceRoot: string,
  workspaceFolders?: { name: string; path: string }[],
  repoRootCache?: RepoRootCache,
): Promise<HandoffResult> {
  const gitignoreContent = options.respectGitignore
    ? await readGitignore(workspaceRoot)
    : undefined;

  const chain = new FilterChain({
    smartFilter: options.smartFilter,
    respectGitignore: options.respectGitignore,
    gitignoreContent,
    customIgnorePatterns: options.customIgnorePatterns,
    maxFileSizeKB: options.maxFileSizeKB,
  });

  // Expand any directory paths (e.g. from Explorer right-click) to their
  // individual files before running the filter pipeline. Deduplicated by
  // relative path so selecting both a folder and one of its files is safe.
  const expanded = await expandToFiles(selected);

  const overrides = new Set(options.overriddenPaths ?? []);
  const included: IncludedFile[] = [];
  const skipped: SkippedFile[] = [];

  for (const sel of expanded) {
    let sizeBytes: number;
    try {
      const stat = await fs.stat(sel.absolutePath);
      if (!stat.isFile()) {
        skipped.push({
          relativePath: sel.relativePath,
          absolutePath: sel.absolutePath,
          reason: 'unreadable',
          detail: 'not a regular file',
          sizeBytes: 0,
        });
        continue;
      }
      sizeBytes = stat.size;
    } catch (e) {
      skipped.push({
        relativePath: sel.relativePath,
        absolutePath: sel.absolutePath,
        reason: 'unreadable',
        detail: e instanceof Error ? e.message : String(e),
        sizeBytes: 0,
      });
      continue;
    }

    const decision = chain.decide({
      relativePath: sel.relativePath,
      sizeBytes,
      isOverridden: overrides.has(sel.relativePath),
    });

    if (!decision.include) {
      skipped.push({
        relativePath: sel.relativePath,
        absolutePath: sel.absolutePath,
        reason: decision.reason,
        detail: decision.detail,
        sizeBytes,
      });
      continue;
    }

    const read = await readFile(sel);
    if (read.kind === 'error') {
      skipped.push({
        relativePath: sel.relativePath,
        absolutePath: sel.absolutePath,
        reason: 'unreadable',
        detail: read.error,
        sizeBytes: read.sizeBytes,
      });
      continue;
    }

    if (read.kind === 'binary' && options.binaryHandling === 'skip') {
      skipped.push({
        relativePath: sel.relativePath,
        absolutePath: sel.absolutePath,
        reason: 'binary-skip',
        detail: `binary file (${formatBytes(read.file.sizeBytes)})`,
        sizeBytes: read.file.sizeBytes,
      });
      continue;
    }

    included.push(read.file);
  }

  included.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  skipped.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );

  // Detect multi-root: infer each file's workspace folder root from its
  // absolutePath + relativePath, then check whether more than one root is
  // present among the included files.
  //
  // For a file { relativePath: 'src/index.ts', absolutePath: '/root/src/index.ts' }
  // the folder root is path.resolve('/root/src/index.ts', '../../') = '/root'.
  function inferFolderRoot(f: { relativePath: string; absolutePath: string }): string {
    const depth = f.relativePath.split('/').length;
    return path.resolve(f.absolutePath, '../'.repeat(depth));
  }

  const folderRoots = new Set(included.map(inferFolderRoot));
  const multiRoot = folderRoots.size > 1;

  // When spanning multiple workspace folders, prefix each file's display path
  // with its folder name so the tree correctly shows e.g.:
  //   workspace/
  //   ├── ai-handoff/
  //   │   └── esbuild.js
  //   └── buzzer/
  //       └── project.yml
  const displayFiles = multiRoot
    ? included.map((f) => ({
        ...f,
        relativePath: `${path.basename(inferFolderRoot(f))}/${f.relativePath}`,
      }))
    : included;

  const rootLabel = multiRoot ? 'workspace' : (path.basename(workspaceRoot) || 'workspace');
  const treeSection = buildTreeForFormat(
    displayFiles.map((f) => f.relativePath),
    options.format,
    { rootLabel },
  );

  let diff = options.gitDiff?.enabled
    ? await readGitDiffForWorkspace(
        workspaceFolders ?? [{ name: path.basename(workspaceRoot) || 'workspace', path: workspaceRoot }],
        options.gitDiff.scope,
        repoRootCache,
      )
    : undefined;
  if (diff && !diff.error) {
    // Scope the diff to the files the user actually selected — otherwise
    // enabling git diff pulls in changes across the whole repo regardless of
    // what's ticked in the tree. Match on resolved absolute path rather than
    // relativePath text, since the diff's path is repo-root-relative while a
    // selected file's relativePath is workspace-folder-relative (and may
    // carry a multi-root folder-name prefix) — these only reliably agree
    // once both are resolved to a real filesystem path. `repoRoot` comes
    // from `git rev-parse --show-toplevel`, which resolves symlinks, so the
    // selected side must be realpath'd too or the two will disagree on
    // systems where the workspace path itself is a symlink (e.g. macOS's
    // /tmp -> /private/tmp).
    const selectedAbsolutePaths = new Set(
      await Promise.all(
        expanded.map(async (f) => {
          try {
            return await fs.realpath(f.absolutePath);
          } catch {
            return path.resolve(f.absolutePath);
          }
        }),
      ),
    );
    diff = {
      ...diff,
      files: diff.files.filter((f) =>
        selectedAbsolutePaths.has(path.resolve(f.repoRoot, f.relativePath)),
      ),
    };
  }
  const diffSection = diff ? formatDiffSection(diff, options.format) : undefined;

  const text = formatHandoff(displayFiles, {
    format: options.format,
    includeLineNumbers: options.includeLineNumbers,
    treeSection,
    diffSection,
    customInstructions: options.customInstructions,
    skippedFiles: skipped,
  });

  const totalSizeBytes = included.reduce((sum, f) => sum + f.sizeBytes, 0);
  const estimatedTokens = estimateTokens(text, options.tokenEstimationRatio);

  // base64 is a post-processing step applied only to the *returned* text —
  // stats are computed above from the real formatted content and must stay
  // that way, not reflect the inflated encoded size.
  const outputText = options.base64Encode ? Buffer.from(text, 'utf-8').toString('base64') : text;

  return {
    text: outputText,
    included,
    skipped,
    diff,
    stats: {
      fileCount: included.length,
      totalSizeBytes,
      estimatedTokens,
      diffFileCount: diff?.files.length ?? 0,
    },
  };
}
