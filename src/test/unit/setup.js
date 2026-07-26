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

Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return {
      window: {},
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
        },
        createFileSystemWatcher: () => ({
          onDidCreate: () => ({ dispose: () => {} }),
          onDidDelete: () => ({ dispose: () => {} }),
          onDidChange: () => ({ dispose: () => {} }),
          dispose: () => {},
        }),
      },
      env: {},
      commands: {},
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
