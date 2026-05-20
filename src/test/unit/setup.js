/**
 * Mocha setup: intercept require('vscode') with a minimal stub so that
 * UI modules can be imported in pure-unit tests without a VS Code host.
 * Only the surface area actually used at module-load time is stubbed.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');
const originalLoad = Module._load.bind(Module);

Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return {
      window: {},
      workspace: { workspaceFolders: undefined },
      env: {},
      commands: {},
      Uri: class Uri {},
      EventEmitter: class EventEmitter {
        event = () => {};
        fire() {}
        dispose() {}
      },
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      TreeItemCheckboxState: { Checked: 1, Unchecked: 0 },
      ThemeIcon: class ThemeIcon {},
    };
  }
  return originalLoad(request, parent, isMain);
};
