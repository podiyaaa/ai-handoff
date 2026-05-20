# Next Steps — Getting AI Handoff onto your machine and into GitHub

This document walks you through everything to do after downloading the project zip.

## 1. Extract and inspect

```bash
unzip ai-handoff.zip
cd ai-handoff
ls -la
```

You should see the source, configs, and a `.git/` directory with full commit history.

## 2. Install dependencies and build

```bash
npm install
npm run compile
```

This compiles TypeScript and bundles into `dist/extension.js`.

## 3. Run the tests

```bash
npm run test:unit          # Fast — pure logic only (~1s)
npm run test:integration   # Slower — boots a real VS Code (~30s)
npm run test:ui            # Slowest — drives the UI (~60s)
npm test                   # Unit + integration
npm run coverage           # Coverage report (saved to coverage/)
```

If anything fails on first run, it's most likely a missing native dep
(common on Linux: install `libnss3 libgbm1 libasound2 libxshmfence1`).

## 4. Try it locally before pushing

```bash
code .             # open the project in VS Code
# Press F5 — this launches an "Extension Development Host" window
# Open any project folder there, then look for the AI Handoff icon
# in the activity bar (left sidebar).
```

Tick a few files, hit Generate Handoff, paste into Claude.

## 5. Push to GitHub

Create a fresh empty repo on GitHub (do NOT auto-init — no README,
no .gitignore, no license, since we have all of those).

Then either:

```bash
# Easy: use the helper script
./setup-github.sh https://github.com/YOUR-USERNAME/ai-handoff.git
```

or manually:

```bash
git remote add origin https://github.com/YOUR-USERNAME/ai-handoff.git
git push -u origin main
```

## 6. Update placeholder values

Search the repo for `your-username` and `your-publisher-id`:

```bash
grep -rn "your-username\|your-publisher-id" --exclude-dir=node_modules --exclude-dir=.git
```

Files to update:
- `package.json` — `publisher`, `repository.url`, `bugs.url`, `homepage`
- `README.md` — repo links
- `LICENSE` — copyright holder name

## 7. Publish to the VS Code Marketplace (optional)

When you're ready to publish publicly:

1. Create a publisher: https://marketplace.visualstudio.com/manage
2. Create a Personal Access Token (PAT) with `Marketplace > Manage` scope:
   https://dev.azure.com/  → User Settings → Personal Access Tokens
3. Add the PAT to GitHub:
   `Settings → Secrets → Actions → New repository secret → VSCE_PAT`
4. Add an icon: `media/icon.png` (128×128 PNG)
5. Tag a release:
   ```bash
   npm version patch    # 0.1.0 -> 0.1.1
   git push --follow-tags
   ```
6. The `publish.yml` workflow auto-runs and pushes to the Marketplace.

Or publish manually:
```bash
npm run vsce:package    # creates ai-handoff-0.1.0.vsix
npm run vsce:publish    # uploads to marketplace (needs VSCE_PAT env var)
```

## 8. Install your own .vsix locally (no marketplace needed)

If you don't want to publish but still want the extension installed in
your offline VS Code:

```bash
npm run vsce:package
code --install-extension ai-handoff-0.1.0.vsix
```

That's it.

## Project structure cheat sheet

```
src/
├── core/                     # Pure logic — no VS Code, no I/O
│   ├── filter.ts             # Inclusion decisions (smart filter / gitignore / size)
│   ├── tree-builder.ts       # ASCII directory tree
│   ├── formatter.ts          # XML / Markdown / Plain output
│   ├── token-estimator.ts    # Offline token count estimate
│   └── types.ts              # Shared type defs
├── services/                 # Side-effectful (filesystem, persistence)
│   ├── file-reader.ts        # Safe file I/O + binary detection
│   ├── handoff-generator.ts  # Top-level pipeline orchestrator
│   └── selection-store.ts    # Persist last selection + named sets
├── ui/                       # VS Code-specific UI
│   ├── file-tree-provider.ts # TreeView with checkboxes
│   ├── action-panel.ts       # Webview (stats / format / generate)
│   └── output-picker.ts      # Quick pick for destination
├── extension.ts              # Activation entry point — wires it all together
└── test/                     # Unit + integration + UI tests
```

The separation of `core/` (pure) from `services/` (I/O) from `ui/` (VS Code)
is deliberate — it's what makes the bulk of the codebase testable without
ever booting a VS Code instance.
