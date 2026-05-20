/**
 * Shared types for the AI Handoff extension.
 * Pure data types — no VS Code API references in this file.
 */

export type OutputFormat = 'xml' | 'markdown' | 'plain';

export type SelectionMemoryMode = 'off' | 'lastOnly' | 'namedSets' | 'both';

export type BinaryHandling = 'placeholder' | 'skip';

export type SkipReason =
  | 'smart-filter'
  | 'gitignore'
  | 'custom-ignore'
  | 'too-large'
  | 'binary-skip'
  | 'unreadable';

/** A single file that the user wants to include in the handoff. */
export interface SelectedFile {
  /** Path relative to the workspace root, using POSIX separators. */
  relativePath: string;
  /** Absolute path on disk. */
  absolutePath: string;
}

/** A file that made it through filtering and is ready to format. */
export interface IncludedFile {
  relativePath: string;
  absolutePath: string;
  /** UTF-8 text content. `null` for binary files included as placeholders. */
  content: string | null;
  /** True if treated as binary (placeholder only, no content). */
  isBinary: boolean;
  /** File size in bytes. */
  sizeBytes: number;
}

/** A file that was filtered out, with a reason and the path. */
export interface SkippedFile {
  relativePath: string;
  absolutePath: string;
  reason: SkipReason;
  /** Optional details (e.g., "4.2 MB > 1 MB limit"). */
  detail?: string;
  sizeBytes: number;
}

/** Options that drive a single handoff generation. */
export interface HandoffOptions {
  format: OutputFormat;
  includeLineNumbers: boolean;
  maxFileSizeKB: number;
  respectGitignore: boolean;
  smartFilter: boolean;
  customIgnorePatterns: string[];
  binaryHandling: BinaryHandling;
  tokenEstimationRatio: number;
  /** Optional custom prompt to prepend. */
  customInstructions?: string;
  /** Paths the user explicitly checked to override filters. */
  overriddenPaths?: string[];
}

/** The final result of a handoff generation. */
export interface HandoffResult {
  /** The fully formatted handoff text, ready to copy or save. */
  text: string;
  /** Files that were included. */
  included: IncludedFile[];
  /** Files that were filtered out, with reasons. */
  skipped: SkippedFile[];
  /** Stats summary. */
  stats: HandoffStats;
}

export interface HandoffStats {
  fileCount: number;
  totalSizeBytes: number;
  estimatedTokens: number;
}
