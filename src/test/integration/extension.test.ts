import { expect } from 'chai';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'your-publisher-id.ai-handoff';

describe('Extension activation', () => {
  it('is present and findable', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    expect(ext, 'extension not found').to.exist;
  });

  it('activates without throwing', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    if (!ext) {
      throw new Error(`Extension ${EXTENSION_ID} not found`);
    }
    await ext.activate();
    expect(ext.isActive).to.be.true;
  });
});

describe('Commands are registered', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    await ext?.activate();
  });

  const expected = [
    'aiHandoff.generateFromExplorer',
    'aiHandoff.generateFromEditor',
    'aiHandoff.generateFromPanel',
    'aiHandoff.refreshTree',
    'aiHandoff.clearSelection',
    'aiHandoff.saveSelectionSet',
    'aiHandoff.loadSelectionSet',
    'aiHandoff.deleteSelectionSet',
  ];

  for (const cmd of expected) {
    it(`registers ${cmd}`, async () => {
      const all = await vscode.commands.getCommands(true);
      expect(all).to.include(cmd);
    });
  }
});

describe('Configuration', () => {
  it('exposes default settings under aiHandoff.*', () => {
    const config = vscode.workspace.getConfiguration('aiHandoff');
    expect(config.get<string>('outputFormat')).to.equal('xml');
    expect(config.get<boolean>('includeLineNumbers')).to.equal(false);
    expect(config.get<number>('maxFileSizeKB')).to.equal(1024);
    expect(config.get<boolean>('smartFilter')).to.equal(true);
    expect(config.get<string>('selectionMemory')).to.equal('lastOnly');
    expect(config.get<string>('binaryHandling')).to.equal('placeholder');
    expect(config.get<boolean>('gitDiffEnabledByDefault')).to.equal(false);
    expect(config.get<string>('gitDiffScope')).to.equal('working');
  });
});

describe('End-to-end: generate handoff via clipboard', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-e2e-'));
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test project');
    await fs.writeFile(path.join(tmpDir, 'index.ts'), 'export const x = 42;');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a handoff to the clipboard via the public API', async function () {
    // We can't drive the UI checkboxes from here, but we can test the
    // core pipeline by invoking the generator directly. The full
    // checkbox-to-clipboard flow is covered by the UI tests.
    this.timeout(10000);
    const { generateHandoff } = await import('../../services/handoff-generator');
    const result = await generateHandoff(
      [
        { relativePath: 'index.ts', absolutePath: path.join(tmpDir, 'index.ts') },
        { relativePath: 'README.md', absolutePath: path.join(tmpDir, 'README.md') },
      ],
      {
        format: 'xml',
        includeLineNumbers: false,
        maxFileSizeKB: 1024,
        respectGitignore: false,
        smartFilter: true,
        customIgnorePatterns: [],
        binaryHandling: 'placeholder',
        tokenEstimationRatio: 4,
      },
      tmpDir,
    );
    expect(result.stats.fileCount).to.equal(2);
    expect(result.text).to.include('<file path="README.md">');
    expect(result.text).to.include('<file path="index.ts">');
    expect(result.text).to.include('export const x = 42;');

    await vscode.env.clipboard.writeText(result.text);
    const fromClipboard = await vscode.env.clipboard.readText();
    expect(fromClipboard).to.equal(result.text);
  });
});
