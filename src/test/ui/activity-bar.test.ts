import { expect } from 'chai';
import { ActivityBar, VSBrowser, Workbench } from 'vscode-extension-tester';

describe('UI: Activity Bar entry', function () {
  this.timeout(30000);

  before(async () => {
    await VSBrowser.instance.openResources();
  });

  it('shows the AI Handoff icon in the activity bar', async () => {
    const activityBar = new ActivityBar();
    const controls = await activityBar.getViewControls();
    const titles = await Promise.all(controls.map((c) => c.getTitle()));
    expect(titles.some((t) => t.toLowerCase().includes('ai handoff'))).to.be.true;
  });

  it('command palette knows the Generate command', async () => {
    const workbench = new Workbench();
    const commandPalette = await workbench.openCommandPrompt();
    await commandPalette.setText('> AI Handoff');
    const picks = await commandPalette.getQuickPicks();
    const labels = await Promise.all(picks.map((p) => p.getLabel()));
    expect(labels.some((l) => l.includes('Generate handoff'))).to.be.true;
    await commandPalette.cancel();
  });
});
