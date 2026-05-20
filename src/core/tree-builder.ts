/**
 * Builds an ASCII directory tree from a list of file paths.
 *
 * Pure module — no filesystem, no VS Code. Just string manipulation.
 *
 * Example input:
 *   ['src/index.ts', 'src/auth/login.ts', 'src/utils/helper.ts', 'README.md']
 *
 * Example output:
 *   my-project/
 *   ├── README.md
 *   └── src/
 *       ├── auth/
 *       │   └── login.ts
 *       ├── index.ts
 *       └── utils/
 *           └── helper.ts
 */

/** Tree drawing characters. */
const BRANCH = '├── ';
const LAST_BRANCH = '└── ';
const VERTICAL = '│   ';
const SPACE = '    ';

/**
 * Internal tree node. Children keyed by segment for deterministic ordering.
 */
interface TreeNode {
  name: string;
  isFile: boolean;
  children: Map<string, TreeNode>;
}

/** Create an empty tree node. */
function makeNode(name: string, isFile: boolean): TreeNode {
  return { name, isFile, children: new Map() };
}

/**
 * Normalize a path to POSIX-style separators and strip leading/trailing slashes.
 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * Insert a single file path into the tree. Mutates `root`.
 */
function insertPath(root: TreeNode, path: string): void {
  const segments = normalizePath(path).split('/').filter(Boolean);
  if (segments.length === 0) {
    return;
  }
  let node = root;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;
    let child = node.children.get(segment);
    if (!child) {
      child = makeNode(segment, isLast);
      node.children.set(segment, child);
    } else if (isLast && !child.isFile && child.children.size === 0) {
      // A previously-recorded directory turned out to be a file with no further children.
      // Unlikely in practice (we don't insert pure directories), but harmless to fix.
      child.isFile = true;
    }
    node = child;
  }
}

/**
 * Sort children: directories first, then files, with simple string comparison
 * within each group (uppercase before lowercase, matching VS Code Explorer).
 */
function sortChildren(node: TreeNode): TreeNode[] {
  const arr = Array.from(node.children.values());
  arr.sort((a, b) => {
    if (a.isFile !== b.isFile) {
      return a.isFile ? 1 : -1;
    }
    // Simple lexicographic comparison — matches VS Code Explorer's default
    // (uppercase letters sort before lowercase, since 'A' < 'a' in ASCII).
    if (a.name < b.name) {
      return -1;
    }
    if (a.name > b.name) {
      return 1;
    }
    return 0;
  });
  return arr;
}

/**
 * Render a node's children recursively. The `prefix` carries the indentation
 * for the current depth (e.g. "│   │   ").
 */
function renderChildren(node: TreeNode, prefix: string, lines: string[]): void {
  const children = sortChildren(node);
  children.forEach((child, idx) => {
    const isLast = idx === children.length - 1;
    const branch = isLast ? LAST_BRANCH : BRANCH;
    const suffix = child.isFile ? '' : '/';
    lines.push(`${prefix}${branch}${child.name}${suffix}`);
    if (!child.isFile && child.children.size > 0) {
      const nextPrefix = prefix + (isLast ? SPACE : VERTICAL);
      renderChildren(child, nextPrefix, lines);
    }
  });
}

/**
 * Options for buildTree.
 */
export interface BuildTreeOptions {
  /** Label for the root (e.g. workspace folder name). Default: 'root/'. */
  rootLabel?: string;
}

/**
 * Build an ASCII tree string from a list of relative file paths.
 *
 * The output starts with the root label (with trailing slash) and uses
 * box-drawing characters for branches. Files are sorted alphabetically
 * within each directory, with directories listed before files.
 */
export function buildTree(filePaths: string[], options: BuildTreeOptions = {}): string {
  const rootLabel = options.rootLabel ?? 'root';
  const root = makeNode(rootLabel, false);

  // Deduplicate paths — multiple selections of the same file shouldn't
  // double up in the tree.
  const unique = Array.from(new Set(filePaths.map(normalizePath))).filter(Boolean);
  for (const p of unique) {
    insertPath(root, p);
  }

  const lines: string[] = [`${rootLabel}/`];
  renderChildren(root, '', lines);
  return lines.join('\n');
}

/**
 * Convenience: build a tree and wrap it in the chosen format's container.
 * Kept separate from the formatter so the tree is reusable on its own.
 */
export function buildTreeForFormat(
  filePaths: string[],
  format: 'xml' | 'markdown' | 'plain',
  options: BuildTreeOptions = {},
): string {
  const tree = buildTree(filePaths, options);
  switch (format) {
    case 'xml':
      return `<directory_structure>\n${tree}\n</directory_structure>`;
    case 'markdown':
      return `## Directory structure\n\n\`\`\`\n${tree}\n\`\`\``;
    case 'plain':
      return `Directory structure:\n${tree}`;
  }
}
