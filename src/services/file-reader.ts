/**
 * File reading service. Reads files from disk safely:
 *   - Stats before reading (so we can skip oversized files cheaply)
 *   - Detects binaries by extension OR content (NUL byte sample)
 *   - Returns null content for binaries; full text for everything else
 *
 * Used by the handoff generator to materialize SelectedFile -> IncludedFile.
 */

import * as fs from 'fs/promises';
import {
  isBinaryByContent,
  isBinaryByExtension,
} from '../core/filter';
import type { IncludedFile, SelectedFile } from '../core/types';

/** Result of reading a single file. */
export type FileReadResult =
  | { kind: 'text'; file: IncludedFile }
  | { kind: 'binary'; file: IncludedFile }
  | { kind: 'error'; relativePath: string; absolutePath: string; sizeBytes: number; error: string };

/**
 * Stat a file on disk. Returns size in bytes, or null if unreadable.
 */
export async function statFile(absolutePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return null;
    }
    return stat.size;
  } catch {
    return null;
  }
}

/**
 * Read a single file from disk. Decides binary vs text and returns
 * an IncludedFile with content populated appropriately.
 *
 * Caller is responsible for filtering BEFORE calling this — the reader
 * does not consult the FilterChain. (Separation of concerns: filtering
 * is pure, reading is I/O.)
 */
export async function readFile(selected: SelectedFile): Promise<FileReadResult> {
  const { absolutePath, relativePath } = selected;

  let sizeBytes = 0;
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return {
        kind: 'error',
        relativePath,
        absolutePath,
        sizeBytes: 0,
        error: 'not a regular file',
      };
    }
    sizeBytes = stat.size;
  } catch (e) {
    return {
      kind: 'error',
      relativePath,
      absolutePath,
      sizeBytes: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // Cheap binary check by extension first.
  if (isBinaryByExtension(relativePath)) {
    return {
      kind: 'binary',
      file: {
        relativePath,
        absolutePath,
        content: null,
        isBinary: true,
        sizeBytes,
      },
    };
  }

  // Read the file. We could read just the first N bytes for binary
  // detection and then re-read in full if text, but for typical project
  // files (<1MB) reading once is fine and simpler.
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(absolutePath);
  } catch (e) {
    return {
      kind: 'error',
      relativePath,
      absolutePath,
      sizeBytes,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // Content-based binary detection — catches files without a known
  // binary extension (e.g. compiled blobs with no extension).
  if (isBinaryByContent(buffer)) {
    return {
      kind: 'binary',
      file: {
        relativePath,
        absolutePath,
        content: null,
        isBinary: true,
        sizeBytes,
      },
    };
  }

  // Decode as UTF-8. Files that decode cleanly are treated as text;
  // anything weird stays mostly intact (the replacement character
  // U+FFFD will appear in malformed sequences, which is acceptable).
  const content = buffer.toString('utf-8');

  return {
    kind: 'text',
    file: {
      relativePath,
      absolutePath,
      content,
      isBinary: false,
      sizeBytes,
    },
  };
}
