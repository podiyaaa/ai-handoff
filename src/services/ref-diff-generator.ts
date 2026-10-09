/**
 * Generate a handoff from the full content of every file that differs
 * between two local branches — for handing an entire PR's changed files to
 * an AI, with full surrounding context (not diff hunks), so it can act on
 * review comments the user pastes in separately.
 *
 * A small parallel pipeline to `handoff-generator.ts`'s `generateHandoff()`,
 * deliberately not threaded through it: content here comes from git blobs
 * (`readFileAtRef`), not the filesystem, since neither ref is guaranteed to
 * be the current checkout. What's cleanly reusable is reused: tree
 * building, `formatHandoff()` (full-file line-numbering falls out of it for
 * free — see `applyLineNumbers()`'s default `startLine` in
 * `core/formatter.ts`), binary detection, token estimation.
 *
 * Multi-repo workspaces: scoped to the first resolved repo root, consistent
 * with this codebase's existing "assume the first folder" precedent
 * elsewhere. A workspace with multiple independent repos would need a repo
 * picker too — out of scope for now.
 */

import * as path from 'path';
import { formatBytes, isBinaryByContent, isBinaryByExtension } from '../core/filter';
import { formatHandoff } from '../core/formatter';
import { estimateTokens } from '../core/token-estimator';
import { buildTreeForFormat } from '../core/tree-builder';
import type {
  BinaryHandling,
  HandoffResult,
  IncludedFile,
  OutputFormat,
  SkippedFile,
} from '../core/types';
import { resolveReposForFolder, RepoRootCache } from './git-diff-reader';
import { listChangedFilesBetweenRefs, readFileAtRef } from './ref-diff-reader';

export interface RefDiffGenerateOptions {
  format: OutputFormat;
  includeLineNumbers: boolean;
  maxFileSizeKB: number;
  binaryHandling: BinaryHandling;
  tokenEstimationRatio: number;
  customInstructions?: string;
  base64Encode?: boolean;
}

/** Thrown when there's nothing sensible to generate from — surfaced to the panel as an inline error, not a confusing empty handoff. */
export class RefDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefDiffError';
  }
}

async function resolveFirstRepoRoot(
  workspaceFolders: { name: string; path: string }[],
  repoRootCache?: RepoRootCache,
): Promise<string | undefined> {
  for (const folder of workspaceFolders) {
    const repos = repoRootCache
      ? await repoRootCache.resolveForFolder(folder)
      : await resolveReposForFolder(folder);
    if (repos.length > 0) {
      return repos[0].toplevel;
    }
  }
  return undefined;
}

export async function generateHandoffFromRefDiff(
  workspaceFolders: { name: string; path: string }[],
  baseRef: string,
  compareRef: string,
  options: RefDiffGenerateOptions,
  repoRootCache?: RepoRootCache,
): Promise<HandoffResult> {
  if (baseRef === compareRef) {
    throw new RefDiffError('Base and compare branches must be different.');
  }

  const repoRoot = await resolveFirstRepoRoot(workspaceFolders, repoRootCache);
  if (!repoRoot) {
    throw new RefDiffError('No git repository found in this workspace.');
  }

  const entries = await listChangedFilesBetweenRefs(repoRoot, baseRef, compareRef);

  const included: IncludedFile[] = [];
  const skipped: SkippedFile[] = [];
  const maxFileSizeBytes = options.maxFileSizeKB * 1024;

  for (const entry of entries) {
    const absolutePath = path.join(repoRoot, entry.relativePath);
    let buffer: Buffer;
    try {
      buffer = await readFileAtRef(repoRoot, compareRef, entry.relativePath);
    } catch (e) {
      skipped.push({
        relativePath: entry.relativePath,
        absolutePath,
        reason: 'unreadable',
        detail: e instanceof Error ? e.message : String(e),
        sizeBytes: 0,
      });
      continue;
    }

    if (buffer.length > maxFileSizeBytes) {
      skipped.push({
        relativePath: entry.relativePath,
        absolutePath,
        reason: 'too-large',
        detail: `${formatBytes(buffer.length)} > ${options.maxFileSizeKB} KB limit`,
        sizeBytes: buffer.length,
      });
      continue;
    }

    const isBinary = isBinaryByExtension(entry.relativePath) || isBinaryByContent(buffer);
    if (isBinary) {
      if (options.binaryHandling === 'skip') {
        skipped.push({
          relativePath: entry.relativePath,
          absolutePath,
          reason: 'binary-skip',
          detail: `binary file (${formatBytes(buffer.length)})`,
          sizeBytes: buffer.length,
        });
        continue;
      }
      included.push({
        relativePath: entry.relativePath,
        absolutePath,
        content: null,
        isBinary: true,
        sizeBytes: buffer.length,
      });
      continue;
    }

    included.push({
      relativePath: entry.relativePath,
      absolutePath,
      content: buffer.toString('utf-8'),
      isBinary: false,
      sizeBytes: buffer.length,
    });
  }

  included.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  skipped.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );

  const treeSection = buildTreeForFormat(
    included.map((f) => f.relativePath),
    options.format,
    { rootLabel: path.basename(repoRoot) || 'repo' },
  );

  const text = formatHandoff(included, {
    format: options.format,
    includeLineNumbers: options.includeLineNumbers,
    treeSection,
    customInstructions: options.customInstructions,
    skippedFiles: skipped,
  });

  const totalSizeBytes = included.reduce((sum, f) => sum + f.sizeBytes, 0);
  const estimatedTokens = estimateTokens(text, options.tokenEstimationRatio);

  const outputText = options.base64Encode ? Buffer.from(text, 'utf-8').toString('base64') : text;

  return {
    text: outputText,
    included,
    skipped,
    stats: {
      fileCount: included.length,
      totalSizeBytes,
      estimatedTokens,
      diffFileCount: 0,
    },
  };
}
