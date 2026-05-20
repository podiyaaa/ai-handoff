# Contributing to AI Handoff

Thanks for your interest! Here's how to get started.

## Development setup

```bash
# Clone and install
git clone https://github.com/your-username/ai-handoff.git
cd ai-handoff
npm install

# Open in VS Code
code .

# Press F5 to launch a new Extension Development Host window
```

## Project structure

```
src/
├── extension.ts              # Activation entry point
├── core/                     # Pure logic (no VS Code API)
│   ├── formatter.ts          # XML / Markdown / Plain text formatters
│   ├── filter.ts             # gitignore + smart filter logic
│   ├── tree-builder.ts       # Directory tree rendering
│   ├── token-estimator.ts    # Token count estimation
│   └── types.ts              # Shared type definitions
├── ui/                       # VS Code-specific UI
│   ├── file-tree-provider.ts # TreeView with checkboxes
│   ├── action-panel.ts       # Webview for the action panel
│   └── output-picker.ts      # Quick pick for destination
├── services/                 # Side-effectful services
│   ├── handoff-generator.ts  # Orchestrates the pipeline
│   ├── file-reader.ts        # Safe file reading
│   └── selection-store.ts    # Persists selections
└── test/                     # All tests
    ├── unit/                 # Pure logic tests
    ├── integration/          # VS Code API tests
    └── ui/                   # Selenium-based UI tests
```

## Running tests

```bash
npm run test:unit          # Fast — pure logic only
npm run test:integration   # Slower — runs in VS Code
npm run test:ui            # Slowest — drives the actual UI
npm test                   # Unit + integration
npm run coverage           # Coverage report
```

## Code style

- TypeScript strict mode is on. Keep it on.
- Prefer pure functions in `core/`. Keep VS Code API calls in `ui/` and `services/`.
- One concern per file. If a file passes ~300 lines, consider splitting.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add markdown output format
fix: handle binary files larger than 1MB
docs: clarify selection memory setting
test: add token estimator edge cases
```

## Pull requests

1. Fork and create a branch from `main`
2. Add tests for any new behavior
3. Run `npm run lint && npm test` before pushing
4. Open a PR with a clear description

## Releasing (maintainers)

1. Update `CHANGELOG.md`
2. Bump version in `package.json` (`npm version patch|minor|major`)
3. Tag and push: `git push --follow-tags`
4. Publish: `npm run vsce:publish`
