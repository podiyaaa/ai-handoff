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
│   ├── token-estimator.ts
│   └── search-filter.ts  # Sidebar search query parsing (name / ext: / re:) + matching
├── ui/                   # VS Code API — display only, no business logic
│   ├── file-tree-provider.ts  # Sidebar TreeView with checkboxes (lazy directory walk + background search index)
│   ├── search-bar-panel.ts    # Webview pinned above the tree — live search input
│   ├── action-panel.ts        # Webview sidebar panel (vanilla HTML/CSS/JS, no framework)
│   └── output-picker.ts       # QuickPick for clipboard / file / tab dispatch
└── services/             # Side-effectful: filesystem I/O + VS Code state
    ├── handoff-generator.ts   # Pipeline orchestrator (stat → filter → read → format)
    ├── file-reader.ts         # Binary detection (by extension, then NUL-byte scan)
    ├── git-diff-reader.ts     # Shells out to `git diff` across every repo in the workspace
    └── selection-store.ts     # Persists selections in vscode.Memento (workspaceState)
```

### Data flow

1. User selects files via the sidebar TreeView **or** Explorer right-click, and/or checks "Include git diff" in the action panel (Working / Staged / Both).
2. `extension.ts` builds `SelectedFile[]` (relative + absolute paths).
3. `generateHandoff()` in `handoff-generator.ts` runs the pipeline:
   - `FilterChain.decide()` categorises each file as included or skipped (with reason).
   - `readFile()` reads text / detects binaries.
   - If git diff is enabled, `readGitDiffForWorkspace()` collects diffs across every repo in the workspace, then `generateHandoff()` filters the result down to just the files in the current selection (matched by resolved absolute path, via `fs.realpath`, against each diff entry's `repoRoot` + repo-relative path) — an empty selection yields an empty diff section.
   - `formatHandoff()` renders the final text string.
4. `pickDestinations()` prompts for clipboard / file / tab, then `dispatchHandoff()` delivers.

### Build system

esbuild bundles `src/extension.ts` → `dist/extension.js` (CJS, `vscode` external). tsc is used **only for type checking** — it never emits the production bundle. Unit tests run directly via `ts-node`; integration/UI tests compile to `out/` via `tsconfig.test.json` first.

## Key design constraints

- **`core/` must stay VS Code-free.** This is what makes unit tests fast and the logic reusable.
- **TypeScript strict mode is fully enabled** (`noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`).
- `SelectionStore` in `services/selection-store.ts` ships with `InMemoryMemento` — use it in tests instead of mocking `vscode.Memento`.
- The action panel webview is intentionally framework-free; all styling uses VS Code CSS variables for automatic theme support.
- File overrides (user clicks "include anyway", or ticks one specific file's own checkbox in the sidebar — see `FileTreeProvider.onDidToggleIndividualFile`) bypass path-based filters but **not** the size limit — this is intentional. Ticking a whole *directory's* checkbox does **not** auto-override — bulk-selecting a folder must stay subject to the smart filter/gitignore, or it could silently drag in its `node_modules`.
- Git diff repo discovery (`git-diff-reader.ts`) is anchored to VS Code workspace folders, each checked for its own repo — a folder that isn't a repo itself is searched recursively (any depth, skipping smart-filter junk dirs, stopping at the first repo found per branch) for nested repos, so opening a plain "folder of projects" — or a folder of folders of projects — as a single workspace root still finds each project's repo. `RepoRootCache` memoizes this per folder for the extension's session (repo layouts rarely change); the sidebar's "Refresh" button invalidates it. Shells out via `execFile` (never a shell string) — never `simple-git`/`isomorphic-git`, to stay dependency-light and offline-first.
- `FileTreeProvider`'s search index is the one deliberate exception to "lazy, no cost up front": `buildSearchIndex()` walks the whole workspace once in the background so search is an in-memory scan instead of a live filesystem walk per keystroke. Falls back to the (slower) on-disk walk until that first build finishes. Kept in sync via the existing file watcher, debounced so a burst of creates/deletes (e.g. `npm install`) triggers one rebuild, not one per event.
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
