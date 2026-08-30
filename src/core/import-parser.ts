/**
 * JS/TS import parsing — pure, VS-Code-free string logic used to drive the
 * "select with imports" feature (see `services/file-tree-model.ts`'s
 * `resolveImportClosure` and `services/tsconfig-resolver.ts`).
 *
 * Regex-based (no real AST), consistent with this codebase's existing
 * lightweight-parsing style (see `core/search-filter.ts`). Extracts EVERY
 * import/require/export-from/dynamic-import specifier, relative and bare
 * alike — classification (relative file vs. tsconfig path alias vs. genuine
 * bare package import) happens later, at resolution time, not here.
 */

export const JS_TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** Whether a workspace-relative path has a JS/TS extension (case-insensitive). */
export function isJsOrTsFile(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return JS_TS_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// `import ... from '...'` / `export ... from '...'` — deliberately permissive
// about what sits between the keyword and `from` (covers `import type`,
// default/namespace/named combinations, multiline named-import lists) as
// long as it doesn't cross a string or statement boundary. `[^'";]` matches
// newlines too (it's not `.`), so a multiline import list still matches.
const IMPORT_EXPORT_FROM_RE = /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g;
// Bare side-effect import: `import '...'` (no `from`, no parens — that's dynamic import).
const BARE_IMPORT_RE = /\bimport\s*['"]([^'"]+)['"]/g;
// `require('...')`
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
// Dynamic `import('...')`
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const PATTERNS = [IMPORT_EXPORT_FROM_RE, BARE_IMPORT_RE, REQUIRE_RE, DYNAMIC_IMPORT_RE];

/**
 * Every import/require/export-from/dynamic-import specifier in the source,
 * relative and bare alike. Order is: all `from`-style matches, then bare
 * imports, then `require(...)`, then dynamic `import(...)` — callers that
 * care about order should dedupe/BFS themselves (see `resolveImportClosure`).
 */
export function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** A relative specifier (`./x`, `../x`) vs. a bare one (`react`, `@app/button`, `/abs/path`). */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
