# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension that lets users select files and generate a formatted bundle (directory tree + file contents) to paste into AI chats. Entirely offline — no network calls, no API keys.

## Commands

```bash
# Development
npm install                    # install deps
npm run compile                # type-check + esbuild (dev build)
npm run watch                  # parallel: esbuild --watch + tsc --watch
npm run check-types            # tsc --noEmit only
npm run lint                   # eslint src/

# Tests
npm run test:unit              # mocha via ts-node — fast, no VS Code required
npm run test:integration       # runs inside VS Code (slower)
npm run test:ui                # Selenium-based UI tests (slowest)
npm test                       # unit + integration
npm run coverage               # c8 coverage over unit tests

# Packaging
npm run package                # production esbuild bundle → dist/extension.js
npm run vsce:package           # builds the .vsix
npm run vsce:publish           # publish to marketplace
```

**Run a single unit test file:**
```bash
npx mocha --require ts-node/register src/test/unit/filter.test.ts
```

**Press F5 in VS Code** to launch an Extension Development Host.

## Architecture

The codebase enforces a hard separation between pure logic and VS Code API usage:

```
src/
├── extension.ts          # Activation, command registration, session state wiring
├── core/                 # Pure TypeScript — zero VS Code API imports
│   ├── types.ts          # All shared interfaces (HandoffOptions, HandoffResult, etc.)
│   ├── filter.ts         # FilterChain: smart filter / gitignore / custom patterns / size
│   ├── formatter.ts      # formatHandoff() → xml | markdown | plain output
│   ├── tree-builder.ts   # ASCII directory tree rendering
│   └── token-estimator.ts
├── ui/                   # VS Code API — display only, no business logic
│   ├── file-tree-provider.ts  # Sidebar TreeView with checkboxes (lazy directory walk)
│   ├── action-panel.ts        # Webview sidebar panel (vanilla HTML/CSS/JS, no framework)
│   └── output-picker.ts       # QuickPick for clipboard / file / tab dispatch
└── services/             # Side-effectful: filesystem I/O + VS Code state
    ├── handoff-generator.ts   # Pipeline orchestrator (stat → filter → read → format)
    ├── file-reader.ts         # Binary detection (by extension, then NUL-byte scan)
    └── selection-store.ts     # Persists selections in vscode.Memento (workspaceState)
```

### Data flow

1. User selects files via the sidebar TreeView **or** Explorer right-click.
2. `extension.ts` builds `SelectedFile[]` (relative + absolute paths).
3. `generateHandoff()` in `handoff-generator.ts` runs the pipeline:
   - `FilterChain.decide()` categorises each file as included or skipped (with reason).
   - `readFile()` reads text / detects binaries.
   - `formatHandoff()` renders the final text string.
4. `pickDestinations()` prompts for clipboard / file / tab, then `dispatchHandoff()` delivers.

### Build system

esbuild bundles `src/extension.ts` → `dist/extension.js` (CJS, `vscode` external). tsc is used **only for type checking** — it never emits the production bundle. Unit tests run directly via `ts-node`; integration/UI tests compile to `out/` via `tsconfig.test.json` first.

## Key design constraints

- **`core/` must stay VS Code-free.** This is what makes unit tests fast and the logic reusable.
- **TypeScript strict mode is fully enabled** (`noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`).
- `SelectionStore` in `services/selection-store.ts` ships with `InMemoryMemento` — use it in tests instead of mocking `vscode.Memento`.
- The action panel webview is intentionally framework-free; all styling uses VS Code CSS variables for automatic theme support.
- File overrides (user clicks "include anyway") bypass path-based filters but **not** the size limit — this is intentional.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, etc.).
