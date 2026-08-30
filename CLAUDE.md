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
├── extension.ts          # Activation, command registration
├── core/                 # Pure TypeScript — zero VS Code API imports
│   ├── types.ts             # All shared interfaces (HandoffOptions, HandoffResult, LineRange, etc.)
│   ├── filter.ts            # FilterChain: smart filter / gitignore / custom patterns / size
│   ├── formatter.ts         # formatHandoff() → xml | markdown | plain output
│   ├── tree-builder.ts      # ASCII directory tree rendering
│   ├── token-estimator.ts
│   ├── search-filter.ts     # Sidebar search query parsing (name / ext: / re:) + matching
│   └── bridge-protocol.ts   # Webview<->host message contract (BridgeMethods/BridgeEvents) — host-agnostic by design, see below
├── ui/                   # VS Code API — display only, no business logic
│   ├── handoff-panel.ts      # The one sidebar view: search + virtualized tree + actions footer, all in a single custom webview
│   ├── webview-host-bridge.ts # HostBridge — implements bridge-protocol.ts's contract against a real vscode.Webview
│   ├── webview-nonce.ts      # CSP nonce generation, shared by any webview
│   └── output-picker.ts      # QuickPick for clipboard / file / tab dispatch
└── services/             # Side-effectful: filesystem I/O + VS Code state
    ├── file-tree-model.ts     # Selection/expand/search state + lazy directory reads + background search index
    ├── handoff-generator.ts   # Pipeline orchestrator (stat → filter → read → format)
    ├── file-reader.ts         # Binary detection (by extension, then NUL-byte scan); slices content when a LineRange is set
    ├── git-diff-reader.ts     # Shells out to `git diff` across every repo in the workspace
    └── selection-store.ts     # Persists selections in vscode.Memento (workspaceState)

media/webview/            # Client-side JS for handoff-panel.ts's webview, loaded via asWebviewUri() — no bundler, no framework
├── bridge-client.js         # Webview-side half of the request/response/event protocol
├── virtual-list.js          # Pure windowing math for the tree (unit-tested); tree-render.js is not (no jsdom)
├── tree-render.js           # DOM-touching tree render: virtualization, checkboxes, ARIA/roving-tabindex keyboard nav
├── search-render.js         # Search input wiring
├── actions-render.js        # Actions footer wiring (format/diff/generate/bookmarks/skipped)
└── main.js                  # Bootstraps the bridge once, then hands it to the four modules above
```

The sidebar used to be three separately-chromed views (a native TreeView, a standalone search-bar webview, and a separate actions webview) — merged into the single `handoff-panel.ts` custom webview to reclaim space VS Code otherwise wastes per stacked view. See `feature/tree-search-webview-merge`'s git history for the staged rewrite that got here; `bridge-protocol.ts` is intentionally VS-Code-free so the same webview UI could in principle be hosted by a different IDE later (not in scope today, just kept cheap not to preclude).

### Data flow

1. User selects files via the sidebar tree **or** Explorer/editor-context right-click, and/or checks "Include git diff" in the actions footer (Working / Staged / Both).
2. `SelectedFile[]` (relative + absolute paths, optionally a `lineRange` for "generate from selected lines") is built — either by `HandoffPanelProvider` from `FileTreeModel`'s current selection, or directly in `extension.ts`'s command handlers for the explorer/editor/selection commands.
3. `generateHandoff()` in `handoff-generator.ts` runs the pipeline:
   - `FilterChain.decide()` categorises each file as included or skipped (with reason).
   - `readFile()` reads text / detects binaries; slices to just the requested lines when `lineRange` is set.
   - If git diff is enabled, `readGitDiffForWorkspace()` collects diffs across every repo in the workspace, then `generateHandoff()` filters the result down to just the files in the current selection (matched by resolved absolute path, via `fs.realpath`, against each diff entry's `repoRoot` + repo-relative path) — an empty selection yields an empty diff section.
   - `formatHandoff()` renders the final text string.
4. `pickDestinations()` prompts for clipboard / file / tab, then `dispatchHandoff()` delivers.

### Build system

esbuild bundles `src/extension.ts` → `dist/extension.js` (CJS, `vscode` external). tsc is used **only for type checking** — it never emits the production bundle. Unit tests run directly via `ts-node`; integration/UI tests compile to `out/` via `tsconfig.test.json` first. `media/webview/*.js` ship as-is (no build step) — `.vscodeignore` still excludes `src/` wholesale, so any webview client-side asset must live under `media/`, never referenced only from `src/`.

## Key design constraints

- **`core/` must stay VS Code-free.** This is what makes unit tests fast and the logic reusable. `bridge-protocol.ts` in particular must never import a `vscode` type — see its module doc.
- **TypeScript strict mode is fully enabled** (`noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`).
- `SelectionStore` in `services/selection-store.ts` ships with `InMemoryMemento` — use it in tests instead of mocking `vscode.Memento`.
- The webview is intentionally framework-free; all styling uses VS Code CSS variables for automatic theme support.
- File overrides (user clicks "include anyway", or ticks one specific file's own checkbox in the sidebar — see `FileTreeModel.onDidToggleIndividualFile`) bypass path-based filters but **not** the size limit — this is intentional. Ticking a whole *directory's* checkbox does **not** auto-override — bulk-selecting a folder must stay subject to the smart filter/gitignore, or it could silently drag in its `node_modules`.
- Git diff repo discovery (`git-diff-reader.ts`) is anchored to VS Code workspace folders, each checked for its own repo — a folder that isn't a repo itself is searched recursively (any depth, skipping smart-filter junk dirs, stopping at the first repo found per branch) for nested repos, so opening a plain "folder of projects" — or a folder of folders of projects — as a single workspace root still finds each project's repo. `RepoRootCache` memoizes this per folder for the extension's session (repo layouts rarely change); the sidebar's "Refresh" view-title icon invalidates it. Shells out via `execFile` (never a shell string) — never `simple-git`/`isomorphic-git`, to stay dependency-light and offline-first.
- `FileTreeModel`'s search index is the one deliberate exception to "lazy, no cost up front": `buildSearchIndex()` walks the whole workspace once in the background so search is an in-memory scan instead of a live filesystem walk per keystroke. Falls back to the (slower) on-disk walk until that first build finishes. Kept in sync via the existing file watcher, debounced so a burst of creates/deletes (e.g. `npm install`) triggers one rebuild, not one per event. `aiHandoff.searchSkipJunkDirs` (default on) and `aiHandoff.searchExcludeDirs` (comma-separated extra glob patterns) both control what the index excludes.
- The tree's own selection ("show selected only" filter) and the search filter are both *display-only* — neither ever changes `FileTreeModel.selected`, and they combine as AND when both are active.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, etc.).

## Git workflow

- **Every bug fix, feature, or change gets its own branch off `master`** — never commit work-in-progress directly to `master`.
- Open a pull request from that branch back to `master`. The user reviews (and manually tests, e.g. via a built `.vsix`) before it merges.
- **Version bumps happen from `master` only, after the user has tested and the branch is merged** — not before, and not on the feature branch. `package.json`/`package-lock.json` version bump + `CHANGELOG.md` entry + `.vsix` build/rebuild all happen post-merge.
- If a branch needs another round of fixes after review/testing, keep iterating on that same branch (new commits, same PR) rather than opening a new one for the same change.

### Pre-release (alpha/beta) builds

For a feature big enough to want wider testing before it merges, the user may explicitly ask to cut a pre-release directly from the feature branch — this is a deliberate, user-approved exception to "version bumps happen from master only," not the default. When asked:

1. Bump `package.json`/`package-lock.json` to the next version (e.g. `0.2.0` → `0.3.0`) **on the feature branch**, add a CHANGELOG entry marked `(pre-release)`, build the `.vsix`.
2. Push the branch, tag it `vX.Y.Z-beta.N` (distinct from the eventual stable `vX.Y.Z` tag to avoid collision), push the tag.
3. `gh release create <tag> --target <branch> --prerelease --notes-file <path> <vsix>` — creating a GitHub release is a visible, hard-to-reverse action; confirm with the user or hand them the exact command rather than assuming.
4. Marketplace: `vsce publish --pre-release` — this needs the user's own publisher access token (`vsce login`), so it's always the user's step, not something to run on their behalf. Same `package.json` version, no semver suffix — the `--pre-release` flag (not the version string) is what marks it as pre-release, so the same version number can later be republished as stable once validated.
