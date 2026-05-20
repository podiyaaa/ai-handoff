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
 * Default filename for the handoff based on the chosen format.
 */
export function defaultFilenameForFormat(format: OutputFormat): string {
  switch (format) {
    case 'xml':
      return 'handoff.xml';
    case 'markdown':
      return 'handoff.md';
    case 'plain':
      return 'handoff.txt';
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
          defaultUri: defaultSaveUri(format),
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
 * else the OS default.
 */
function defaultSaveUri(format: OutputFormat): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const name = defaultFilenameForFormat(format);
  // Build a Uri inside the first workspace folder
  return vscode.Uri.file(folders[0].uri.fsPath + '/' + name);
}
