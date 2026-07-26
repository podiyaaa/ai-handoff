# Changelog

All notable changes to the **AI Handoff** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Search/filter bar above the sidebar file tree** — a persistent search box (its own small panel, pinned directly above the Files tree) filters the tree down to matching files as you type. Supports three modes: plain text (substring match against the path), `ext:ts,tsx` (match by extension), and `re:^use[A-Z]` (regex, case-insensitive), with an inline error hint for invalid input. Directories containing a match reliably expand once a search settles — including ones you'd already collapsed by hand — via `TreeView.reveal()`, and a clear (✕) button appears while the box has text. Purely a display filter — it never changes what's selected.
- **"Expand All" button** — the Files view title bar has an Expand All action (alongside VS Code's native "Collapse All") that reliably opens every directory, also via `TreeView.reveal()`.

### Changed

- **Search bar visual polish** — the search panel's background now matches the Files tree right below it instead of the default webview background, its content is vertically centered instead of pinned to the top, and the "ext:/re:" hint line only appears while the box is focused or has text — so at rest it reads as a single compact row instead of a mostly-empty panel.

### Fixed

- **Manually checking a file found via search could be silently dropped** — ticking an individual file's checkbox only added it to the selection; it didn't bypass the smart filter/gitignore, so a file you'd deliberately searched for and checked (e.g. inside `dist/` or `node_modules/`) could still vanish from the generated handoff with no warning. Ticking one specific file's own checkbox now auto-registers it as a filter override, same as clicking "include anyway" in the skipped-files list. Ticking a whole *directory's* checkbox is unaffected — bulk-selecting a folder still respects the smart filter/gitignore, so it can't accidentally drag in its `node_modules`.
- **Checkbox clicks near a search change could select the wrong item** — an earlier attempt at search-triggered auto-expand forced already-rendered folders open by tagging every tree item's `id` with a counter bumped on every search keystroke, so VS Code would treat the whole tree as new. That churn, happening automatically and repeatedly while you might be mid-click on a checkbox in the search results, could get a click misattributed to the wrong (ancestor) node — e.g. ticking one file right before clearing the search box could end up toggling its entire parent folder instead, silently selecting many unintended files. Replaced entirely with `TreeView.reveal()` (the documented API for forcing an item open), which doesn't touch item identity and can't affect an in-flight checkbox click. Also replaced the earlier custom Collapse-All/Expand-All toggle (which had the same id-churn problem and, on top of that, simply didn't reliably work) with VS Code's native "Collapse All" plus a `reveal()`-based "Expand All".

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
