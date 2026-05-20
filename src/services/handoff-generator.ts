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
import { formatHandoff } from '../core/formatter';
import { estimateTokens } from '../core/token-estimator';
import { buildTreeForFormat } from '../core/tree-builder';
import type {
  HandoffOptions,
  HandoffResult,
  IncludedFile,
  SelectedFile,
  SkippedFile,
} from '../core/types';
import { readFile } from './file-reader';

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
 * Run the full handoff pipeline.
 */
export async function generateHandoff(
  selected: SelectedFile[],
  options: HandoffOptions,
  workspaceRoot: string,
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

  const overrides = new Set(options.overriddenPaths ?? []);
  const included: IncludedFile[] = [];
  const skipped: SkippedFile[] = [];

  for (const sel of selected) {
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

  const rootLabel = path.basename(workspaceRoot) || 'workspace';
  const treeSection = buildTreeForFormat(
    included.map((f) => f.relativePath),
    options.format,
    { rootLabel },
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

  return {
    text,
    included,
    skipped,
    stats: {
      fileCount: included.length,
      totalSizeBytes,
      estimatedTokens,
    },
  };
}
