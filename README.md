# AI Handoff

> Select multiple files in VS Code and instantly generate a clean, structured handoff — directory tree + file contents — ready to paste into any AI chat. Works fully offline.

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Why?

You're working in VS Code, you want to ask Claude / ChatGPT / Gemini for help with a few related files, and copy-pasting them one by one is painful. **AI Handoff** lets you tick a few files and get a properly formatted bundle:

```xml
<directory_structure>
my-project/
├── src/
│   ├── index.ts
│   └── auth/
│       └── login.ts
</directory_structure>

<file path="src/index.ts">
[file contents]
</file>

<file path="src/auth/login.ts">
[file contents]
</file>
```

Paste it into any AI chat. Done.

## Features

- 📁 **Two selection methods** — right-click in the Explorer (multi-select with Ctrl/Cmd) or use the dedicated sidebar with checkboxes
- 🎯 **AI-optimized output** — XML format by default (parses cleanly in any LLM), with Markdown and plain text as alternatives
- 🌲 **Directory tree included** — shows the structure of selected files and their parent paths
- 🧹 **Smart filtering** — auto-skips `node_modules`, `.git`, `dist`, build folders, and binary files; respects `.gitignore`
- 🔍 **Transparent skips** — see exactly what was filtered out, with one-click override
- 📊 **Stats at a glance** — file count, total size in KB, estimated token count
- 💾 **Selection memory** — auto-restore last selection, or save named selection sets ("Auth module", "API layer")
- 📋 **Flexible output** — copy to clipboard, save to file, or open in a new editor tab
- 🔌 **Fully offline** — no network calls, no API keys, your code stays on your machine
- ⚙️ **Configurable** — line numbers, file size limits, ignore patterns, format, and more

## Installation

### From Marketplace

1. Open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`)
2. Search for **AI Handoff**
3. Click **Install**

### From `.vsix`

```bash
code --install-extension ai-handoff-0.1.0.vsix
```

## Usage

### Quick path: right-click

1. Select one or more files / folders in the Explorer (Ctrl/Cmd-click for multi-select)
2. Right-click → **AI Handoff: Generate from selection**
3. Pick a destination (clipboard / file / new tab)
4. Paste into your favorite AI chat

### Power path: sidebar

1. Click the **AI Handoff** icon in the activity bar
2. Tick the files and folders you want
3. (Optional) Toggle on custom instructions and add a prompt
4. Click **Generate Handoff**

## Configuration

All settings live under `aiHandoff.*`:

| Setting | Default | Description |
|---|---|---|
| `outputFormat` | `xml` | `xml`, `markdown`, or `plain` |
| `includeLineNumbers` | `false` | Add line numbers to file contents |
| `maxFileSizeKB` | `1024` | Hard-skip files larger than this |
| `respectGitignore` | `true` | Skip files matched by `.gitignore` |
| `smartFilter` | `true` | Auto-skip junk paths and binaries |
| `customIgnorePatterns` | `[]` | Extra glob patterns to ignore |
| `selectionMemory` | `lastOnly` | `off` / `lastOnly` / `namedSets` / `both` |
| `binaryHandling` | `placeholder` | `placeholder` or `skip` |
| `tokenEstimationRatio` | `4` | Chars per token (estimate) |
| `showCustomInstructions` | `false` | Show the instructions text area |

## Output formats

### XML (default — best for AI)

```xml
<file path="src/index.ts">
const greet = (name: string) => `Hello, ${name}`;
</file>
```

### Markdown

````markdown
### `src/index.ts`

```typescript
const greet = (name: string) => `Hello, ${name}`;
```
````

### Plain text

```
--- src/index.ts ---
const greet = (name: string) => `Hello, ${name}`;
```

## Privacy

AI Handoff runs entirely on your machine. **Nothing is sent over the network.** No telemetry, no API calls, no analytics.

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
