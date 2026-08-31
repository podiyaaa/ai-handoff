# Changelog

All notable changes to the **AI Handoff** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1] — 2026-08-31 (pre-release)

### Fixed

- **"Generate handoff with imports"** (renamed from "Select with Imports") is now a standalone action, like "Generate handoff from this file" — it generates immediately from a JS/TS file plus its direct (first-level) imports, rather than checking boxes in the sidebar tree. Previously it silently reported "added 0 file(s)" whenever the file or its imports happened to already be selected, even though import resolution itself was working correctly. Always resolves first-level imports only now, regardless of the sidebar's "Follow imports recursively" toggle — that toggle governs only the automatic tree-checkbox cascade.

## [0.5.0] — 2026-08-31 (pre-release)

### Added

- **Base64-encoded output** — a checkbox next to the output-format picker base64-encodes the final handoff text on top of whichever format (XML/Markdown/plain) is already chosen, applied as a post-processing step rather than a new format. Stats (file count/size/token estimate) reflect the real content, not the ~33% larger encoded size. Also available as two new right-click commands — `AI Handoff: Generate from selection (Base64)` and `AI Handoff: Generate handoff from this file (Base64)` — that force it on without touching the sidebar's live settings.
- **JS/TS import-following selection** — two new actions-footer toggles, "Look for imports (JS/TS)" and "Follow imports recursively" (recursive by default): when enabled, checking a JS/TS file's checkbox in the tree also auto-selects the files it imports. Resolution covers relative (`./`, `../`) imports and `tsconfig.json`/`jsconfig.json` path aliases (`compilerOptions.paths`/`baseUrl`, including a local `extends` chain) — bare package imports are never resolved onto `node_modules`. Also available as a standalone "Generate handoff with imports" right-click command (Explorer/editor context, JS/TS files only) that generates immediately from the file plus its direct (first-level) imports, without touching the sidebar's tree selection.

## [0.4.0] — 2026-08-30

### Added

- **Merged sidebar view** — the three separately-chromed views (Search, Files, Actions) are now a single "AI Handoff" view: search box, virtualized file tree, and the actions footer (format/diff/generate/instructions/bookmarks/skipped files) all in one place, reclaiming the vertical space VS Code wastes on a minimum height per stacked view. The file tree itself is a custom-rendered, windowed list — built to stay fast on very large projects (only what's actually visible is ever rendered, and only what's actually expanded is ever read from disk).
- **Keyboard navigation for the file tree** — arrow keys move focus and scroll as needed, Home/End jump to the first/last visible row, Right/Left expand/collapse a directory, Enter opens a file (or expands/collapses a directory), Space toggles the focused row's checkbox. Full ARIA tree/treeitem semantics for screen readers.
- **"Generate handoff from this file"** — right-click inside an editor, or right-click its tab, to generate a handoff from just that one file without touching the sidebar selection.
- **"Generate handoff from selected lines"** — select some text in the editor, right-click, and generate a handoff containing just that excerpt (shown with its real line numbers, e.g. "lines 120-145", not renumbered from 1).
- **"Show selected files only"** — a view-title toggle that filters the tree down to just what's currently selected (and its parent folders), useful for double-checking a large selection before generating.
- **"Collapse all"** — a view-title button that collapses every expanded folder at once. No "Expand all" — expanding everything at once isn't safe on a huge project, since the tree is read lazily.
- New setting `aiHandoff.searchExcludeDirs` — a comma-separated list of extra directory glob patterns (e.g. `vendor,coverage,**/generated`) to keep out of the sidebar search index, on top of the built-in defaults (`aiHandoff.searchSkipJunkDirs`).

### Changed

- **Selection persistence now applies to the merged view too** — `aiHandoff.selectionMemory` (auto-restoring your last selection) works the same way it always did, just against the new single view.
- **"Unselect all" and "Refresh"** are now view-title icons next to the panel's title, alongside "Show selected only"/"Collapse all", instead of separate menu-only commands.
- Plain-text sidebar search now matches the **file name only**, not the full path — searching "wo" no longer surfaces every file under a folder named `workspace`. `ext:`/`re:` search modes are unchanged and still match the full path.

### Removed

- The old three-view sidebar (native file tree, standalone search bar, standalone actions panel) is gone, replaced entirely by the merged view above.

### Fixed

- **Stats could lag behind the actual selection** after a rapid sequence of selecting/deselecting files or loading bookmarks — the displayed file count/size/token estimate could briefly (or persistently, until the next change) reflect an older selection than what the tree actually showed. Fixed by discarding stale, out-of-order background updates.
- **Tree checkbox and expand-arrow theming** — checkboxes now use the theme's accent color instead of the browser default, and the focus ring around a checkbox only shows for keyboard navigation (Tab), not a mouse click. Expand/collapse arrows use real codicon glyphs instead of plain Unicode triangles.
- **No workspace folder open** now shows an explanatory message in the tree area instead of silently rendering as blank.

## [0.3.1] — 2026-07-28 (pre-release)

### Added

- **Background search index** — the sidebar search box now matches against an in-memory index built once by a background workspace walk, instead of re-reading directories from disk on every keystroke. Kept in sync automatically as files are created/deleted. By default the index skips the same junk paths as the smart filter (node_modules, .git, dist, build, lock files, etc.) so they don't clutter search results; new setting `aiHandoff.searchSkipJunkDirs` turns that off if you want everything searchable. Search still works immediately on a fresh window — it just falls back to the (slower) on-disk walk until the first background build finishes.

### Changed

- **Git diff scoped to the current file selection** — previously included changes across the whole workspace regardless of what was ticked in the tree; now only the diff for files you've actually selected is included, and it's empty with nothing selected.
- **Nested git repo discovery now searches any depth** — a folder that isn't a repo itself used to be scanned only one level down for nested repos; it's now searched recursively (skipping junk paths, stopping at the first repo found per branch), so a "folder of folders of projects" opened as a single workspace root is covered too. Discovery is cached for the session and can be forced to re-scan via the sidebar's "Refresh" button.

### Removed

- **Expand All / Collapse All toggle** — the Files view title-bar button (added in 0.2.0) forced a full recursive walk of the entire tree, which hung on very large projects. Removed entirely rather than optimized, since there's no bounded way to "expand everything" on a tree that's read lazily.

### Fixed

- **Clearing the search box no longer force-expands the whole tree** — the auto-expand that reveals matching folders while a search is active was also firing once the box was cleared, which (with no filter left) meant a full, unbounded walk that opened every directory in the project. On a very large repo this was a serious hang. Auto-expand now only ever runs while a search query is active, so it stays bounded to the (small) match set; clearing the box leaves the tree's expand/collapse state as-is.
- **General sidebar file tree lagginess** — every directory read (expanding a folder, refreshing, ticking a directory's checkbox to bulk-select it) used to hit disk fresh with no caching at all; now cached per-directory and invalidated only where a file actually changed. The file watcher also used to fire an immediate, unthrottled tree refresh on every single create/delete — a burst of filesystem activity (autosave, a linter writing cache files, git operations, an incremental build) meant one full refresh per event, each forcing VS Code to re-fetch every currently-expanded node. Now debounced (300ms) so a burst collapses into one refresh. The background search index's own rebuild also no longer fires a redundant full tree refresh when no search is active, since nothing displayed would have changed anyway.

## [0.3.0] — 2026-07-27 (pre-release)

### Added

- **"Include git diff" in the action panel** — a checkbox next to the output format dropdown appends a git diff section to the handoff, with a scope dropdown: Working (unstaged), Staged only, or Both (rendered as separate labeled sections). Works additively alongside selected files, or on its own with nothing selected. Diffs are collected via the `git` CLI (no new dependency) across every repo in the workspace — each workspace folder is checked for its own repo, and folders that aren't repos themselves are scanned one level down for nested ones, so both true multi-root workspaces and a plain "folder of projects" opened as a single root are covered. When multiple repos contribute, each file's path is prefixed with its repo name to stay unambiguous. New settings: `aiHandoff.gitDiffEnabledByDefault` and `aiHandoff.gitDiffScope`.

## [0.2.0] — 2026-07-26

### Added

- **Search/filter bar above the sidebar file tree** — a persistent search box (its own small panel, pinned directly above the Files tree) filters the tree down to matching files as you type. Supports three modes: plain text (substring match against the path), `ext:ts,tsx` (match by extension), and `re:^use[A-Z]` (regex, case-insensitive), with an inline error hint for invalid input and a clear (✕) button while the box has text. Directories containing a match expand automatically once a search settles — including ones you'd already collapsed by hand — via `TreeView.reveal()` + a new `FileTreeProvider.getParent()`. Purely a display filter — it never changes what's selected. A status-bar spinner shows while a search (or Expand All) is actively revealing folders.
- **Single Expand All / Collapse All toggle** — one button in the Files view title bar that alternates between the two, instead of two separate always-visible buttons.

### Changed

- **Search bar visual polish** — the search panel's background matches the Files tree right below it, content is vertically centered, and the "ext:/re:" hint line only appears while the box is focused or has text — so at rest it reads as a single compact row instead of a mostly-empty panel.
- **File overrides** — ticking an individual file's own checkbox in the sidebar (e.g. after finding it via search) now auto-registers it as a filter override, same as clicking "include anyway" in the skipped-files list — so a file you deliberately searched for and checked (even inside `dist/` or `node_modules/`) no longer silently vanishes from the generated handoff. Ticking a whole *directory's* checkbox is unaffected — bulk-selecting a folder still respects the smart filter/gitignore, so it can't accidentally drag in its `node_modules`.

### Fixed

- **Ticking one file's checkbox could select its entire parent folder** — VS Code's native tree checkbox feature auto-includes every ancestor directory in the same checkbox-change event, marking them "checked" too, to keep ancestor checkboxes visually in sync. `handleCheckboxChange` was treating every entry in that batch as an independent user action, so those auto-included ancestors triggered full recursive bulk-selects nobody asked for — the deeper the checked file, the more ancestor folders got swept in. Fixed by only acting on the one item in a batch that isn't an ancestor of any other item in the same batch; everything else is VS Code's sync notification, not a click, and is now ignored.

## [0.1.9] — 2026-07-26

### Fixed

- **Multi-root file selector** — the sidebar file tree (the actual file-selection UI) only ever walked and let you select files from the first workspace folder (`folders[0]`), even though earlier fixes had already corrected the Explorer right-click path and the directory tree display for multi-root workspaces. Every open workspace folder now appears as its own top-level node in the sidebar, and files from any of them can be ticked and included in a handoff.

## [0.1.8] — 2026-07-24

### Added

- **Bookmarks** — save any file selection as a named bookmark directly from the action panel. Each bookmark appears in a new "Bookmarks" list with `[load]`, `[override]`, and `[delete]` actions:
  - **Load** restores the bookmark's file selection to the sidebar tree.
  - **Override** replaces the bookmark's stored paths with the current selection.
  - **Delete** removes the bookmark.
  - Saving with an existing name prompts for confirmation before overwriting.
  - Bookmarks persist across sessions via `workspaceState` (same storage as named selection sets).

## [0.1.7] — 2026-06-16

### Fixed

- **Multi-root directory tree** — when files from two or more workspace folders are selected together, each file's path is now prefixed with its folder name (`ai-handoff/esbuild.js`, `buzzer/project.yml`) and the tree root is labelled `workspace/`. Previously all files were shown under the primary folder's name regardless of which project they belonged to.

## [0.1.6] — 2026-06-16

### Fixed

- **Multi-root workspace support for Explorer right-click** — right-clicking files from any workspace folder (not just the first one) now works. Previously all URIs were resolved relative to `folders[0]`, so files from `folders[1...]` were silently dropped with "no files selected". The handler now uses `vscode.workspace.getWorkspaceFolder()` per URI to compute the correct relative path for each file.
- **Directory expansion no longer breaks cross-root paths** — when expanding a selected folder, child relative paths are now built from the parent's relative path instead of `path.relative(workspaceRoot, child)`, which produced `../…` paths for files outside the primary folder.
- **Robust URI detection for Explorer context menu** — VS Code can pass URIs as plain serialised objects (`{ scheme, path, … }`) without a `fsPath` property. The handler now falls back to the raw `path` field for `file://` objects so clicks are never silently ignored.

## [0.1.3] — 2026-05-27

### Fixed

- Re-packaged for Marketplace upload (0.1.2 upload failed)

## [0.1.2] — 2026-05-27

### Fixed

- **Folder selection no longer bleeds into parent directories** — checking a subfolder (e.g. `src/core`) no longer caused the parent (`src`) to appear fully selected in the sidebar. Clicking that falsely-checked parent would then select everything inside it. The sidebar now tracks explicitly-ticked directories separately so only the directories you actually clicked show a checkmark.
- **Right-click on a folder now works** — selecting a folder in the Explorer and choosing "AI Handoff: Generate from selection" previously produced nothing (the folder path was silently skipped as "not a regular file"). Folders are now recursively expanded to their constituent files before the filter pipeline runs.
- **Mixed folder + file selections are deduplicated** — selecting both a directory and one of its files no longer processes that file twice.

## [0.1.1] — 2026-05-20

### Changed

- Updated publisher ID to `RavinduKanchana` for Marketplace listing
- Added app icon and corrected repository / homepage URLs in `package.json`
- Network access is now blocked at runtime (any accidental `fetch` or `XMLHttpRequest` call throws immediately with a clear message)

## [0.1.0] — Unreleased

### Added

**Core logic** (pure, no VS Code dependencies)
- Filter chain: smart filter, gitignore support, custom patterns, size limits, overrides
- Directory tree builder with proper ASCII branches and VS Code-style sorting
- Output formatters: XML (default, best for AI), Markdown, plain text
- Token estimator (offline, configurable chars-per-token ratio)
- Binary file detection by extension + NUL-byte heuristic

**Services**
- File reader with safe stat + UTF-8 decoding
- Handoff generator orchestrating the full pipeline
- Selection store with persistence (last selection + named sets)

**UI**
- Native VS Code TreeView with checkboxes in the sidebar
- Webview action panel with stats, format dropdown, instructions, generate button
- Skipped files list with [include anyway] overrides
- Quick pick destination chooser (clipboard / file / new tab / all)

**Commands**
- Right-click in Explorer → "AI Handoff: Generate from selection"
- Sidebar panel → "Generate Handoff" button
- Save / load / delete named selection sets via command palette

**Configuration** (10 settings under `aiHandoff.*`)
- `outputFormat`, `includeLineNumbers`, `maxFileSizeKB`, `respectGitignore`,
  `smartFilter`, `customIgnorePatterns`, `selectionMemory`, `binaryHandling`,
  `tokenEstimationRatio`, `showCustomInstructions`

**Tooling**
- TypeScript + esbuild build pipeline
- Mocha + Chai unit tests (200+ assertions)
- @vscode/test-electron integration tests
- vscode-extension-tester UI tests
- c8 coverage (~85% target)
- ESLint with TypeScript rules
- GitHub Actions CI (multi-OS, multi-Node)
- GitHub Actions publish workflow (tag-triggered)
- VS Code launch config for F5 debugging
