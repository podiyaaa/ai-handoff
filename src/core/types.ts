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

export type DiffScope = 'working' | 'staged' | 'both';

export type DiffChangeType = 'added' | 'modified' | 'deleted' | 'renamed';

/** A single file's changes as reported by `git diff`. */
export interface DiffFileChange {
  /** Repo-root-relative path, as git reports it. */
  relativePath: string;
  /** Set when changeType === 'renamed'. */
  oldPath?: string;
  changeType: DiffChangeType;
  /** Unified diff hunk text for this file (or a binary-marker line). */
  patch: string;
  isBinary: boolean;
  /** Which of the two diffs this hunk came from — relevant when scope === 'both'. */
  staged: boolean;
  /** Basename of the contributing repo root, used to disambiguate multi-repo workspaces. */
  repoLabel: string;
  /** Absolute path of the contributing repo's root — used to resolve `relativePath` back to an absolute path for selection filtering. */
  repoRoot: string;
}

export interface GitDiffOptions {
  enabled: boolean;
  scope: DiffScope;
}

/** The result of collecting git diffs across every repo in the workspace. */
export interface GitDiffResult {
  scope: DiffScope;
  /** Merged across every repo that contributed; split back out via `repoLabel`/`staged` when rendering. */
  files: DiffFileChange[];
  /** Workspace folder names that aren't git repos. Informational only, not an error. */
  reposWithNoGit: string[];
  /** 'no-repos-found': none of the workspace folders are git repos. 'git-not-found': the git binary isn't on PATH. */
  error?: 'no-repos-found' | 'git-not-found';
  errorDetail?: string;
}

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
  /** When set, appends a git diff section to the handoff, filtered down to the current file selection (empty selection → empty diff). */
  gitDiff?: GitDiffOptions;
}

/** The final result of a handoff generation. */
export interface HandoffResult {
  /** The fully formatted handoff text, ready to copy or save. */
  text: string;
  /** Files that were included. */
  included: IncludedFile[];
  /** Files that were filtered out, with reasons. */
  skipped: SkippedFile[];
  /** Git diff result, present when `HandoffOptions.gitDiff.enabled` was set. */
  diff?: GitDiffResult;
  /** Stats summary. */
  stats: HandoffStats;
}

export interface HandoffStats {
  fileCount: number;
  totalSizeBytes: number;
  estimatedTokens: number;
  diffFileCount: number;
}

/**
 * One row of the file tree, as sent to the webview. Deliberately excludes
 * `absolutePath` — the host already resolves relativePath → absolutePath
 * wherever it's needed (opening a file, resolving a selection for
 * generation), so there's no legitimate reason to send a filesystem-absolute
 * path into a webview.
 */
export interface TreeNodeInfo {
  relativePath: string;
  name: string;
  isDirectory: boolean;
  /**
   * 'partial' is reserved for a future enhancement (a directory with some
   * but not all descendants selected) — the current model only ever
   * produces 'checked'/'unchecked', matching today's actual behavior.
   */
  checkboxState: 'checked' | 'unchecked' | 'partial';
  /** Only meaningful while a search query is active. */
  matchesSearch: boolean;
}
