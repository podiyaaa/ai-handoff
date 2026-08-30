/**
 * tsconfig.json/jsconfig.json `paths`/`baseUrl` parsing and alias matching —
 * pure string/JSON logic only, no file reads (that's `services/
 * tsconfig-resolver.ts`'s job, since it needs `vscode.workspace.fs` for I/O
 * and to walk/merge an `extends` chain). VS-Code-free, same as every other
 * `core/` module.
 *
 * Scope, confirmed with the user: tsconfig/jsconfig `paths` only — webpack
 * (`resolve.alias`) / Babel (`babel-plugin-module-resolver`) style aliases
 * are an explicitly deferred future addition, not implemented here.
 */

export interface TsPathsConfig {
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

/**
 * Strips `//` and `/* *\/` comments plus trailing commas so tsconfig.json's
 * JSONC can `JSON.parse`. String contents (single- or double-quoted) are
 * left untouched — a `//` or `/*` inside a string literal is not treated as
 * a comment start.
 */
export function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  const len = text.length;
  let inString = false;
  let stringChar = '';

  while (i < len) {
    const c = text[i];
    const next = i + 1 < len ? text[i + 1] : '';

    if (inString) {
      result += c;
      if (c === '\\') {
        // Preserve the escaped character too, so an escaped quote doesn't
        // prematurely end the string.
        if (i + 1 < len) {
          result += text[i + 1];
          i += 2;
          continue;
        }
      } else if (c === stringChar) {
        inString = false;
      }
      i++;
      continue;
    }

    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      result += c;
      i++;
      continue;
    }

    if (c === '/' && next === '/') {
      i += 2;
      while (i < len && text[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (c === '/' && next === '*') {
      i += 2;
      while (i < len && !(text[i] === '*' && i + 1 < len && text[i + 1] === '/')) {
        i++;
      }
      i += 2; // skip the closing */
      continue;
    }

    result += c;
    i++;
  }

  // Trailing commas: a comma followed only by whitespace before a closing
  // `}`/`]` is invalid JSON but common in hand-edited tsconfig.json files.
  result = result.replace(/,(\s*[}\]])/g, '$1');

  return result;
}

/**
 * Parses one tsconfig/jsconfig file's own `compilerOptions.baseUrl`/`paths`,
 * plus its raw `extends` value (returned unresolved — the caller does the
 * file-path resolution and I/O to follow it). Returns `undefined` if the
 * text isn't valid JSON(C) or isn't a JSON object at the top level.
 */
export function parseTsconfigPaths(text: string): { config: TsPathsConfig; extends?: string } | undefined {
  const stripped = stripJsonComments(text);
  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return undefined;
  }

  const obj = json as Record<string, unknown>;
  const compilerOptions =
    typeof obj.compilerOptions === 'object' && obj.compilerOptions !== null
      ? (obj.compilerOptions as Record<string, unknown>)
      : {};

  const config: TsPathsConfig = {};
  if (typeof compilerOptions.baseUrl === 'string') {
    config.baseUrl = compilerOptions.baseUrl;
  }
  if (typeof compilerOptions.paths === 'object' && compilerOptions.paths !== null) {
    const paths: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(compilerOptions.paths as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        paths[key] = value.filter((v): v is string => typeof v === 'string');
      }
    }
    config.paths = paths;
  }

  const extendsValue = typeof obj.extends === 'string' ? obj.extends : undefined;
  return { config, extends: extendsValue };
}

/**
 * Given a bare specifier and a `paths` map (already merged/resolved by the
 * caller across an `extends` chain), returns candidate paths relative to
 * `baseUrl` to probe on disk — wildcard-aware (`"@app/*"` -> `"src/app/*"`),
 * longest-prefix-match first, matching `tsc`'s own tie-breaking rule. An
 * exact (non-wildcard) key match always wins over any wildcard pattern.
 * Returns `[]` if nothing matches.
 */
export function matchPathAlias(specifier: string, paths: Record<string, string[]>): string[] {
  if (Object.prototype.hasOwnProperty.call(paths, specifier)) {
    return [...paths[specifier]];
  }

  let bestPrefixLength = -1;
  let bestTargets: string[] = [];

  for (const [pattern, targets] of Object.entries(paths)) {
    const starIndex = pattern.indexOf('*');
    if (starIndex === -1) {
      continue; // exact patterns already handled above
    }
    const prefix = pattern.slice(0, starIndex);
    const suffix = pattern.slice(starIndex + 1);
    if (
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      specifier.length >= prefix.length + suffix.length
    ) {
      if (prefix.length > bestPrefixLength) {
        bestPrefixLength = prefix.length;
        bestTargets = [];
      }
      if (prefix.length === bestPrefixLength) {
        const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
        for (const target of targets) {
          bestTargets.push(target.includes('*') ? target.replace('*', matched) : target);
        }
      }
    }
  }

  return bestTargets;
}
