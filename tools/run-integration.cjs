const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-proposals-vscode-'));
  const workspace = path.join(temp, 'workspace');
  const home = path.join(temp, 'home');
  const userData = path.join(temp, 'user-data');
  for (const directory of [workspace, home, path.join(userData, 'User')]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'files.autoSave': 'off', 'workbench.startupEditor': 'none', 'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off', 'window.restoreWindows': 'none'
  }));
  let executable = process.env.VSCODE_EXECUTABLE_PATH;
  if (!executable && process.platform === 'win32') {
    const installed = path.join(process.env.LOCALAPPDATA || '', 'Programs/Microsoft VS Code/Code.exe');
    if (fs.existsSync(installed)) executable = installed;
  }
  try {
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: process.env.REVIEW_PROPOSALS_EXTENSION_ROOT || root,
      extensionTestsPath: path.join(root, 'out/integration/index.js'),
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
        '--user-data-dir=' + userData, '--extensions-dir=' + path.join(temp, 'extensions')],
      extensionTestsEnv: { ELECTRON_RUN_AS_NODE: undefined, REVIEW_PROPOSALS_TEST_ROOT: temp, REVIEW_PROPOSALS_TEST_HOME: home, USERPROFILE: home, HOME: home, REVIEW_PROPOSALS_NODE: process.execPath }
    });
  } finally {
    // Targets were allocated by this runner; never remove a computed user workspace.
    if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'review-proposals-vscode-')) throw new Error('Unsafe test cleanup target.');
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
