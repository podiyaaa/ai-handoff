/**
 * Search/filter query parsing for the sidebar file tree.
 *
 * This module is PURE — no VS Code API, no filesystem access. It parses a
 * single input-box string into a typed query and tests candidate paths
 * against it. Kept separate from `filter.ts` because this is a *display*
 * filter (what the user sees in the tree) rather than an *inclusion* filter
 * (what ends up in the generated handoff).
 *
 * Query syntax (a single string, e.g. typed into an input box):
 *   - `ext:ts,tsx`   — match by extension (comma-separated, leading dots optional)
 *   - `re:^use[A-Z]` — match by regex (case-insensitive) against the relative path
 *     (deliberately path-based, not just the filename — anchoring a regex to
 *     a directory, e.g. `re:^src/components/`, is a useful power-user case)
 *   - anything else  — case-insensitive substring match against the file's
 *     *name* only, not the full path — matching the path too made short
 *     queries noisy (e.g. "wo" matching every file under a `workspace/`
 *     folder regardless of the file's own name)
 */

export type SearchMode = 'name' | 'extension' | 'regex';

export interface ParsedSearchQuery {
  mode: SearchMode;
  /** The original (trimmed) input string, for display and re-editing. */
  raw: string;
  /** Only set when mode is 'regex'. */
  regex?: RegExp;
  /** Only set when mode is 'extension' — lowercase, no leading dot. */
  extensions?: string[];
}

export interface ParsedSearchResult {
  query: ParsedSearchQuery | undefined;
  error: string | undefined;
}

const EXTENSION_PREFIX = 'ext:';
const REGEX_PREFIX = 're:';

/**
 * Parse a raw input-box string into a query. An empty/whitespace-only input
 * parses to `{ query: undefined, error: undefined }`, meaning "no filter".
 */
export function parseSearchQuery(input: string): ParsedSearchResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { query: undefined, error: undefined };
  }

  if (trimmed.toLowerCase().startsWith(EXTENSION_PREFIX)) {
    const extensions = trimmed
      .slice(EXTENSION_PREFIX.length)
      .split(',')
      .map((e) => e.trim().replace(/^\./, '').toLowerCase())
      .filter((e) => e.length > 0);
    if (extensions.length === 0) {
      return {
        query: undefined,
        error: `"${EXTENSION_PREFIX}" requires at least one extension, e.g. ${EXTENSION_PREFIX}ts,tsx`,
      };
    }
    return { query: { mode: 'extension', raw: trimmed, extensions }, error: undefined };
  }

  if (trimmed.toLowerCase().startsWith(REGEX_PREFIX)) {
    const pattern = trimmed.slice(REGEX_PREFIX.length);
    try {
      return { query: { mode: 'regex', raw: trimmed, regex: new RegExp(pattern, 'i') }, error: undefined };
    } catch (e) {
      return { query: undefined, error: `Invalid regex: ${(e as Error).message}` };
    }
  }

  return { query: { mode: 'name', raw: trimmed }, error: undefined };
}

/**
 * Test whether a file matches a parsed query.
 *
 * @param relativePath POSIX-style path (used for regex matching).
 * @param name The file's base name (used for name/extension matching).
 */
export function matchesSearchQuery(
  relativePath: string,
  name: string,
  query: ParsedSearchQuery,
): boolean {
  switch (query.mode) {
    case 'extension': {
      const dot = name.lastIndexOf('.');
      const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
      return query.extensions!.includes(ext);
    }
    case 'regex':
      return query.regex!.test(relativePath);
    case 'name':
      return name.toLowerCase().includes(query.raw.toLowerCase());
  }
}
