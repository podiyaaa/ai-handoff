/**
 * Output destination picker.
 *
 * After generating a handoff, the user picks where it should go:
 *   - Copy to clipboard (fastest)
 *   - Save to a file (handoff.xml / .md / .txt)
 *   - Open in a new editor tab
 *   - All three at once
 *
 * The picker is a thin async function — it returns the chosen destinations.
 * The caller is responsible for actually writing/saving/opening.
 */

import * as vscode from 'vscode';
import type { OutputFormat } from '../core/types';
import { sanitizeFilenameSegment } from '../core/filename';

export type Destination = 'clipboard' | 'file' | 'tab';

interface DestPickItem extends vscode.QuickPickItem {
  destinations: Destination[];
}

/**
 * Show the destination picker. Returns the chosen destinations, or
 * an empty array if the user cancelled.
 */
export async function pickDestinations(): Promise<Destination[]> {
  const items: DestPickItem[] = [
    {
      label: '$(clippy) Copy to clipboard',
      description: 'Paste it straight into Claude / ChatGPT',
      destinations: ['clipboard'],
    },
    {
      label: '$(save) Save to file...',
      description: 'Choose a location on disk',
      destinations: ['file'],
    },
    {
      label: '$(new-file) Open in new editor tab',
      description: 'Review before copying',
      destinations: ['tab'],
    },
    {
      label: '$(check-all) All three',
      description: 'Clipboard + file + tab',
      destinations: ['clipboard', 'file', 'tab'],
    },
  ];

  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder: 'Where should the handoff go?',
  });

  return chosen?.destinations ?? [];
}

/**
 * Default filename for the handoff based on a base name (typically the
 * project name) and the chosen format.
 */
export function defaultFilenameForFormat(baseName: string, format: OutputFormat): string {
  switch (format) {
    case 'xml':
      return `${baseName}.xml`;
    case 'markdown':
      return `${baseName}.md`;
    case 'plain':
      return `${baseName}.txt`;
  }
}

/**
 * Filters for the Save dialog based on the chosen format.
 */
export function saveFiltersForFormat(format: OutputFormat): { [name: string]: string[] } {
  switch (format) {
    case 'xml':
      return { 'XML files': ['xml'], 'Text files': ['txt'], 'All files': ['*'] };
    case 'markdown':
      return { 'Markdown': ['md', 'markdown'], 'Text files': ['txt'], 'All files': ['*'] };
    case 'plain':
      return { 'Text files': ['txt'], 'All files': ['*'] };
  }
}

/**
 * Language ID for the new-editor-tab document. Affects syntax highlighting
 * in the preview tab.
 */
export function languageIdForFormat(format: OutputFormat): string {
  switch (format) {
    case 'xml':
      return 'xml';
    case 'markdown':
      return 'markdown';
    case 'plain':
      return 'plaintext';
  }
}

/**
 * Top-level helper: take a handoff text and dispatch to the user's chosen
 * destinations. Returns a list of human-readable status messages for the
 * status bar / notification.
 */
export async function dispatchHandoff(
  text: string,
  format: OutputFormat,
  destinations: Destination[],
): Promise<string[]> {
  const messages: string[] = [];

  for (const dest of destinations) {
    switch (dest) {
      case 'clipboard':
        await vscode.env.clipboard.writeText(text);
        messages.push('Copied to clipboard');
        break;

      case 'file': {
        const uri = await vscode.window.showSaveDialog({
          saveLabel: 'Save handoff',
          defaultUri: await defaultSaveUri(format),
          filters: saveFiltersForFormat(format),
        });
        if (uri) {
          const encoder = new TextEncoder();
          await vscode.workspace.fs.writeFile(uri, encoder.encode(text));
          messages.push(`Saved to ${uri.fsPath}`);
        }
        break;
      }

      case 'tab': {
        const doc = await vscode.workspace.openTextDocument({
          content: text,
          language: languageIdForFormat(format),
        });
        await vscode.window.showTextDocument(doc);
        messages.push('Opened in new tab');
        break;
      }
    }
  }

  return messages;
}

/**
 * Pick a default Uri for the Save dialog: workspace root if available,
 * else the OS default. The filename is based on the project name rather
 * than a generic "handoff" so multiple saved handoffs (e.g. from different
 * projects) don't collide or read as interchangeable.
 */
async function defaultSaveUri(format: OutputFormat): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const projectName = await resolveProjectName(folders);
  const name = defaultFilenameForFormat(projectName, format);
  // Build a Uri inside the first workspace folder
  return vscode.Uri.file(folders[0].uri.fsPath + '/' + name);
}

/**
 * Resolve a filename-safe project name to use as the default save name:
 * a single folder's own package.json "name" field, falling back to the
 * folder's own basename, or "workspace" when multiple folders are open
 * (matching generateHandoff()'s own multi-root root-label convention).
 * A timestamped fallback covers the case where nothing usable is found.
 */
async function resolveProjectName(folders: readonly vscode.WorkspaceFolder[]): Promise<string> {
  if (folders.length > 1) {
    return 'workspace';
  }

  const folder = folders[0];

  try {
    const pkgUri = vscode.Uri.joinPath(folder.uri, 'package.json');
    const bytes = await vscode.workspace.fs.readFile(pkgUri);
    const pkg = JSON.parse(Buffer.from(bytes).toString('utf8')) as { name?: unknown };
    if (typeof pkg.name === 'string') {
      const sanitized = sanitizeFilenameSegment(pkg.name);
      if (sanitized) {
        return sanitized;
      }
    }
  } catch {
    // No package.json, unreadable, or invalid JSON — fall through.
  }

  const folderName = sanitizeFilenameSegment(folder.name);
  if (folderName) {
    return folderName;
  }

  return `ai-handoff-${Date.now()}`;
}
