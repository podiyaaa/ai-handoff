/**
 * Mocha setup: intercept require('vscode') with a minimal stub so that
 * UI modules can be imported in pure-unit tests without a VS Code host.
 * Only the surface area actually used at module-load time is stubbed.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realFs = require('fs/promises');
const originalLoad = Module._load.bind(Module);

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}
ThemeIcon.File = new ThemeIcon('file');

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class EventEmitter {
  constructor() {
    this._listeners = [];
    this.event = (listener) => {
      this._listeners.push(listener);
      return { dispose: () => {} };
    };
  }
  fire(e) {
    for (const listener of this._listeners) {
      listener(e);
    }
  }
  dispose() {
    this._listeners = [];
  }
}

class RelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}

// Bitmask values match vscode.FileType so `type & FileType.X` checks work.
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

// Shared across every `require('vscode')` call (each of which otherwise
// gets its own fresh stub object) so a test can assert on what a completely
// separate module (e.g. src/ui/handoff-panel.ts) passed to
// vscode.commands.executeCommand, by reading this array directly.
const executedCommands = [];
global.__testExecutedCommands = executedCommands;

// Same idea for vscode.window.show*Message calls — recorded here so a test
// can assert a message was shown without needing its own vscode import.
const windowMessages = { information: [], warning: [], error: [] };
global.__testWindowMessages = windowMessages;

// Canned responses for interactive window prompts (showInputBox etc.) —
// set these from a test *before* triggering the action that shows the
// prompt; defaults simulate the user cancelling (undefined/empty array).
const windowResponses = { showInputBox: undefined, showWarningMessage: undefined, showQuickPick: undefined };
global.__testWindowResponses = windowResponses;

Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return {
      window: {
        showInputBox: async () => windowResponses.showInputBox,
        showWarningMessage: async (message) => {
          windowMessages.warning.push(message);
          return windowResponses.showWarningMessage;
        },
        showInformationMessage: (message) => {
          windowMessages.information.push(message);
        },
        showErrorMessage: (message) => {
          windowMessages.error.push(message);
        },
        showQuickPick: async () => windowResponses.showQuickPick,
        withProgress: async (_options, task) => task(),
      },
      workspace: {
        workspaceFolders: undefined,
        fs: {
          // Backed by the real filesystem so tests can use real temp dirs
          // (matching this repo's convention of exercising real fixtures
          // rather than mocking fs).
          readDirectory: async (uri) => {
            const entries = await realFs.readdir(uri.fsPath, { withFileTypes: true });
            return entries.map((e) => {
              let type = FileType.Unknown;
              if (e.isDirectory()) type |= FileType.Directory;
              if (e.isFile()) type |= FileType.File;
              if (e.isSymbolicLink()) type |= FileType.SymbolicLink;
              return [e.name, type];
            });
          },
          readFile: async (uri) => {
            const buf = await realFs.readFile(uri.fsPath);
            return new Uint8Array(buf);
          },
          stat: async (uri) => {
            const s = await realFs.stat(uri.fsPath);
            let type = FileType.Unknown;
            if (s.isDirectory()) type |= FileType.Directory;
            if (s.isFile()) type |= FileType.File;
            if (s.isSymbolicLink()) type |= FileType.SymbolicLink;
            return { type, size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs };
          },
        },
        createFileSystemWatcher: () => ({
          onDidCreate: () => ({ dispose: () => {} }),
          onDidDelete: () => ({ dispose: () => {} }),
          onDidChange: () => ({ dispose: () => {} }),
          dispose: () => {},
        }),
        // No test exercises actual configured values (they'd need a real
        // VS Code host) — always returning the caller's own default is
        // enough for code that just needs getConfiguration().get() to not throw.
        getConfiguration: () => ({
          get: (_key, defaultValue) => defaultValue,
        }),
      },
      env: {},
      commands: {
        executeCommand: (command, ...args) => {
          executedCommands.push({ command, args });
          return Promise.resolve();
        },
      },
      Uri: {
        file: (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` }),
      },
      EventEmitter,
      TreeItem,
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      TreeItemCheckboxState: { Checked: 1, Unchecked: 0 },
      ThemeIcon,
      FileType,
      RelativePattern,
    };
  }
  return originalLoad(request, parent, isMain);
};
