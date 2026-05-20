# Changelog

All notable changes to the **AI Handoff** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
