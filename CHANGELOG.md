# Changelog

All notable changes to the **AI Handoff** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
