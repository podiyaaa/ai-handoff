# Changelog

All notable changes to the **AI Handoff** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
