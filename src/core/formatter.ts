/**
 * Output formatters for the handoff. Pure functions — no I/O, no VS Code.
 *
 * Three formats:
 *   - xml      → <file path="..."> ... </file>  (best for AI parsing)
 *   - markdown → ### `path`\n```lang\n...\n```
 *   - plain    → --- path ---\n...
 *
 * Each format also handles:
 *   - Binary placeholders (extension-detected files)
 *   - Optional line numbers
 *   - Optional custom instructions at the top
 *   - Directory tree section
 */

import type { IncludedFile, OutputFormat, SkippedFile } from './types';
import { formatBytes } from './filter';

/**
 * Options for formatHandoff.
 */
export interface FormatOptions {
  format: OutputFormat;
  includeLineNumbers: boolean;
  /** Pre-built directory tree section string (e.g. from buildTreeForFormat). */
  treeSection?: string;
  /** Optional custom instructions to prepend. */
  customInstructions?: string;
  /** Files that were filtered out, appended as a skipped section. */
  skippedFiles?: SkippedFile[];
}

/**
 * Format a complete handoff document.
 * Sorts included files by relative path before rendering.
 * Sections are separated by blank lines and ordered:
 *   instructions → tree → files → skipped
 */
export function formatHandoff(included: IncludedFile[], options: FormatOptions): string {
  const sorted = [...included].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );

  const parts: string[] = [];

  if (options.customInstructions && options.customInstructions.trim().length > 0) {
    parts.push(formatInstructions(options.customInstructions.trim(), options.format));
  }

  if (options.treeSection) {
    parts.push(options.treeSection);
  }

  for (const file of sorted) {
    parts.push(formatFile(file, options));
  }

  if (options.skippedFiles && options.skippedFiles.length > 0) {
    parts.push(formatSkipped(options.skippedFiles, options.format));
  }

  return parts.join('\n\n');
}

/**
 * Wrap user-supplied custom instructions in the format's container.
 */
export function formatInstructions(text: string, format: OutputFormat): string {
  switch (format) {
    case 'xml':
      return `<instructions>\n${text}\n</instructions>`;
    case 'markdown':
      return `## Instructions\n\n${text}`;
    case 'plain':
      return `Instructions:\n${text}`;
  }
}

/**
 * Format a single file with the chosen format.
 */
export function formatFile(file: IncludedFile, options: FormatOptions): string {
  if (file.isBinary) {
    return formatBinaryPlaceholder(file, options.format);
  }

  const content =
    file.content === null
      ? ''
      : options.includeLineNumbers
        ? applyLineNumbers(file.content)
        : file.content;

  switch (options.format) {
    case 'xml':
      return `<file path="${escapeXmlAttr(file.relativePath)}">\n${content}\n</file>`;
    case 'markdown': {
      const lang = getLanguageForPath(file.relativePath);
      const fence = chooseFence(content);
      return [`### \`${file.relativePath}\``, '', `${fence}${lang}`, content, fence].join('\n');
    }
    case 'plain':
      return `--- ${file.relativePath} ---\n${content}`;
  }
}

/**
 * Render a binary file as a placeholder (no content).
 */
export function formatBinaryPlaceholder(file: IncludedFile, format: OutputFormat): string {
  switch (format) {
    case 'xml':
      return `<file path="${escapeXmlAttr(file.relativePath)}" type="binary" size="${formatBytesCompact(file.sizeBytes)}" />`;
    case 'markdown':
      return `### \`${file.relativePath}\`\n\n_Binary file (${formatBytes(file.sizeBytes)}) — content omitted._`;
    case 'plain':
      return `--- ${file.relativePath} ---\n[binary file, ${formatBytes(file.sizeBytes)}, content omitted]`;
  }
}

/**
 * Format the list of skipped files (with reasons) as an appended section.
 */
export function formatSkipped(skipped: SkippedFile[], format: OutputFormat): string {
  const count = skipped.length;
  const grouped = groupSkippedByReason(skipped);
  const lines: string[] = [];

  for (const [reason, files] of grouped) {
    const label = humanizeReason(reason);
    lines.push(`${label} (${files.length}):`);
    for (const f of files) {
      const detail = f.detail ? ` — ${f.detail}` : '';
      lines.push(`  • ${f.relativePath}${detail}`);
    }
    lines.push('');
  }
  const body = lines.join('\n').trimEnd();

  switch (format) {
    case 'xml':
      return `<skipped_files count="${count}">\n${body}\n</skipped_files>`;
    case 'markdown':
      return `## Skipped files (${count})\n\n\`\`\`\n${body}\n\`\`\``;
    case 'plain':
      return `Skipped files (${count}):\n${body}`;
  }
}

/**
 * Add line numbers to file content. Numbers are right-aligned to the width
 * of the largest line number for clean visual columns.
 */
export function applyLineNumbers(content: string): string {
  const lines = content.split('\n');
  const width = String(lines.length).length;
  return lines
    .map((line, idx) => `${String(idx + 1).padStart(width, ' ')}  ${line}`)
    .join('\n');
}

/**
 * Choose the shortest code fence that won't collide with the file content.
 * Returns "```" unless the content itself contains a run of 3+ backticks,
 * in which case returns one backtick longer than the longest such run.
 */
export function chooseFence(content: string): string {
  const matches = content.match(/`{3,}/g) ?? [];
  const maxLen = matches.reduce((max, m) => Math.max(max, m.length), 2);
  return '`'.repeat(maxLen + 1);
}

/**
 * Map a file path to a Markdown code-fence language hint.
 * Returns an empty string when nothing maps cleanly.
 */
export function getLanguageForPath(relativePath: string): string {
  const lastDot = relativePath.lastIndexOf('.');
  const lastSlash = Math.max(relativePath.lastIndexOf('/'), relativePath.lastIndexOf('\\'));

  if (lastDot === -1 || lastDot <= lastSlash + 1) {
    // No extension or dotfile — look up by full filename (lowercased).
    const base = relativePath.substring(lastSlash + 1).toLowerCase();
    return EXTENSIONLESS_LANGUAGE_HINTS[base] ?? '';
  }
  const ext = relativePath.substring(lastDot + 1).toLowerCase();
  return LANGUAGE_HINTS[ext] ?? '';
}

/**
 * Escape characters that are special inside an XML attribute value.
 */
export function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ---------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------

function humanizeReason(reason: string): string {
  switch (reason) {
    case 'smart-filter':
      return 'Smart filter';
    case 'gitignore':
      return 'Gitignore';
    case 'custom-ignore':
      return 'Custom ignore pattern';
    case 'too-large':
      return 'Over size limit';
    case 'binary-skip':
      return 'Binary (skipped)';
    case 'unreadable':
      return 'Unreadable';
    default:
      return reason;
  }
}

function groupSkippedByReason(skipped: SkippedFile[]): Map<string, SkippedFile[]> {
  const map = new Map<string, SkippedFile[]>();
  for (const f of skipped) {
    const arr = map.get(f.reason) ?? [];
    arr.push(f);
    map.set(f.reason, arr);
  }
  return map;
}

/**
 * Compact byte formatter for XML attributes — omits the space between
 * the number and unit (e.g. "24.0KB" instead of "24.0 KB").
 */
function formatBytesCompact(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

const LANGUAGE_HINTS: Readonly<Record<string, string>> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', scala: 'scala',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish', ps1: 'powershell',
  sql: 'sql',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  json: 'json', jsonc: 'jsonc',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
  md: 'markdown', mdx: 'mdx', tex: 'latex',
  dart: 'dart', lua: 'lua', pl: 'perl', r: 'r',
  ex: 'elixir', exs: 'elixir', erl: 'erlang',
  hs: 'haskell', elm: 'elm', clj: 'clojure',
  vue: 'vue', svelte: 'svelte', astro: 'astro',
  graphql: 'graphql', gql: 'graphql',
  proto: 'protobuf', zig: 'zig', nim: 'nim', v: 'v', jl: 'julia',
};

const EXTENSIONLESS_LANGUAGE_HINTS: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  rakefile: 'ruby',
  gemfile: 'ruby',
  vagrantfile: 'ruby',
  '.gitignore': 'gitignore',
  '.env': 'bash',
  '.editorconfig': 'ini',
};
