/**
 * Filter logic for deciding which files to include in a handoff.
 *
 * This module is PURE — no VS Code API, no filesystem access.
 * It takes paths + content/metadata as input and returns decisions.
 * That keeps it trivially testable and reusable.
 */

import ignore, { Ignore } from 'ignore';
import type { SkipReason } from './types';

/**
 * Default "junk" path patterns matched by the smart filter.
 * These are paths almost no one wants in an AI handoff.
 *
 * Uses gitignore-style globs (handled by the `ignore` package).
 */
export const DEFAULT_SMART_FILTER_PATTERNS: readonly string[] = [
  // Dependency folders
  'node_modules/',
  'bower_components/',
  'vendor/',
  '.pnp/',
  '.yarn/',

  // Build outputs
  'dist/',
  'build/',
  'out/',
  'target/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.parcel-cache/',

  // VCS
  '.git/',
  '.svn/',
  '.hg/',

  // IDE / editor
  '.idea/',
  '.vscode-test/',
  '*.iml',

  // OS
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',

  // Python
  '__pycache__/',
  '*.pyc',
  '.venv/',
  'venv/',
  '.tox/',

  // Logs
  '*.log',
  'logs/',

  // Coverage / test artifacts
  'coverage/',
  '.nyc_output/',

  // Lock files (usually not useful for AI review)
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',

  // Misc caches
  '.cache/',
  '.eslintcache',
];

/**
 * Parse `aiHandoff.searchExcludeDirs` — a comma-separated list of
 * directory glob patterns (e.g. `"vendor,coverage,**\/generated"`) the
 * user wants left out of the sidebar search index. Each entry is trimmed
 * and normalized to a directory-only gitignore-style pattern (a trailing
 * `/` is appended if missing) so `foo` excludes the *directory* `foo`, not
 * an unrelated file that happens to share its name — matching this
 * setting's stated purpose. Empty entries (blank/whitespace between two
 * commas) are dropped.
 */
export function parseSearchExcludeDirs(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.endsWith('/') ? entry : `${entry}/`));
}

/**
 * File extensions treated as binary by extension alone.
 * These are skipped or placeholder'd without reading bytes.
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif',
  '.psd', '.ai', '.eps', '.heic', '.heif', '.raw', '.cr2', '.nef',
  // Vectors that are commonly large/binary in practice
  '.fig', '.sketch', '.xd',
  // Audio
  '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma',
  // Video
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v',
  // Archives
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz', '.tgz',
  // Documents (binary formats)
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp',
  // Executables / libraries
  '.exe', '.dll', '.so', '.dylib', '.bin', '.app', '.deb', '.rpm',
  '.msi', '.dmg', '.pkg', '.apk', '.ipa',
  // Compiled
  '.o', '.a', '.class', '.jar', '.war', '.pyc', '.pyo', '.wasm',
  // Fonts
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // Databases
  '.db', '.sqlite', '.sqlite3', '.mdb',
  // Other binary-ish
  '.iso', '.img', '.dat',
]);

/**
 * Get just the extension (with leading dot, lowercase) from a path.
 * Returns empty string if no extension.
 *
 * Dotfiles ('.gitignore', 'src/.env') are treated as having NO extension,
 * matching how most tools (gitignore, VS Code) think about them.
 */
export function getExtension(path: string): string {
  const lastDot = path.lastIndexOf('.');
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (lastDot === -1) {
    return '';
  }
  // The dot must be strictly *after* the start of the filename portion.
  // If the dot is at position lastSlash + 1, it's a dotfile, not an extension.
  if (lastDot <= lastSlash + 1) {
    return '';
  }
  return path.substring(lastDot).toLowerCase();
}

/**
 * Quick check: is this path a binary file based on extension alone?
 * Doesn't read bytes — just looks at the extension.
 */
export function isBinaryByExtension(relativePath: string): boolean {
  return BINARY_EXTENSIONS.has(getExtension(relativePath));
}

/**
 * Heuristic: scan the first N bytes for a NUL byte. If present, treat as binary.
 * Use this when extension alone isn't conclusive.
 */
export function isBinaryByContent(buffer: Buffer, sampleSize = 8192): boolean {
  const len = Math.min(buffer.length, sampleSize);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Combined binary check: extension first (cheap), then content if a buffer is provided.
 */
export function isBinary(relativePath: string, buffer?: Buffer): boolean {
  if (isBinaryByExtension(relativePath)) {
    return true;
  }
  if (buffer) {
    return isBinaryByContent(buffer);
  }
  return false;
}

/**
 * Inputs to the filter chain for a single file.
 */
export interface FilterInput {
  /** Path relative to workspace root, POSIX separators. */
  relativePath: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Optional: bytes of the file for content-based binary detection. */
  buffer?: Buffer;
  /** True if user explicitly overrode this file (force include). */
  isOverridden?: boolean;
}

/**
 * Options for building the filter chain.
 */
export interface FilterOptions {
  smartFilter: boolean;
  respectGitignore: boolean;
  /** Combined .gitignore content from all .gitignore files in the workspace. */
  gitignoreContent?: string;
  customIgnorePatterns: string[];
  maxFileSizeKB: number;
}

/**
 * The reason a file was filtered (or null if it passes).
 */
export type FilterDecision =
  | { include: true }
  | { include: false; reason: SkipReason; detail?: string };

/**
 * A reusable filter chain. Build it once per handoff generation, then call
 * `.decide(file)` for each file.
 *
 * The order of checks matters:
 *   1. Overrides win — always include
 *   2. Smart filter (junk paths)
 *   3. gitignore
 *   4. Custom ignore patterns
 *   5. Size limit
 *   6. Binary detection (only handled at the formatter level, not here)
 */
export class FilterChain {
  private readonly smartIgnore: Ignore | null;
  private readonly gitIgnore: Ignore | null;
  private readonly customIgnore: Ignore | null;
  private readonly maxFileSizeBytes: number;

  constructor(private readonly options: FilterOptions) {
    this.smartIgnore = options.smartFilter
      ? ignore().add([...DEFAULT_SMART_FILTER_PATTERNS])
      : null;

    this.gitIgnore =
      options.respectGitignore && options.gitignoreContent
        ? ignore().add(options.gitignoreContent)
        : null;

    this.customIgnore =
      options.customIgnorePatterns.length > 0
        ? ignore().add(options.customIgnorePatterns)
        : null;

    this.maxFileSizeBytes = options.maxFileSizeKB * 1024;
  }

  /**
   * Decide whether a file should be included.
   * Returns the first failing reason, or `{ include: true }`.
   */
  decide(input: FilterInput): FilterDecision {
    const { relativePath, sizeBytes, isOverridden } = input;

    // Overrides bypass all path-based filters but NOT the size check —
    // we don't want to silently include a 500MB file just because someone
    // clicked "override". They'd need to also raise maxFileSizeKB.
    // (This is a deliberate safety choice.)
    if (!isOverridden) {
      if (this.smartIgnore && this.smartIgnore.ignores(relativePath)) {
        return {
          include: false,
          reason: 'smart-filter',
          detail: 'matched a default junk pattern',
        };
      }

      if (this.gitIgnore && this.gitIgnore.ignores(relativePath)) {
        return {
          include: false,
          reason: 'gitignore',
          detail: 'matched .gitignore',
        };
      }

      if (this.customIgnore && this.customIgnore.ignores(relativePath)) {
        return {
          include: false,
          reason: 'custom-ignore',
          detail: 'matched a custom ignore pattern',
        };
      }
    }

    if (sizeBytes > this.maxFileSizeBytes) {
      return {
        include: false,
        reason: 'too-large',
        detail: `${formatBytes(sizeBytes)} > ${this.options.maxFileSizeKB} KB limit`,
      };
    }

    return { include: true };
  }
}

/**
 * Format a byte count as a human-readable string ("1.2 MB", "850 KB", "523 B").
 * Exported for use in the UI/skip-list display.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
