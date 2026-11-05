import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, gitListTracked, gitGetBaseline,
  sleep, waitForCondition, enableHunktracker, disableHunktracker,
  writeFileExternally, cleanWorkspace,
} from './helpers';

// ── Test suite ────────────────────────────────────────────────────────────────

suite('hunktracker lifecycle integration', function () {
  this.timeout(30000);

  setup(async function () {
    await cleanWorkspace();
  });

  teardown(async function () {
    try { await disableHunktracker(); } catch { /* ignore */ }
    await cleanWorkspace();
  });

  test('enable creates hunktracker git directory and settings', async () => {
    const root = getWorkspaceRoot();
    const hunktrackerDir = path.join(root, '.vscode', 'hunktracker');
    const gitDir = path.join(hunktrackerDir, 'git');
    const settingsPath = path.join(hunktrackerDir, 'settings.json');

    assert.ok(!fs.existsSync(gitDir), 'Git dir should not exist before enable');

    await enableHunktracker();

    assert.ok(fs.existsSync(gitDir), 'Git dir should exist after enable');
    assert.ok(fs.existsSync(settingsPath), 'Settings file should exist after enable');

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.ok(Array.isArray(settings.ignorePatterns), 'Settings should have ignorePatterns');
    assert.ok(settings.ignorePatterns.includes('.git'), '.git should be in default ignorePatterns');
    assert.strictEqual(settings.respectGitignore, true, 'respectGitignore should default to true');
  });

  test('disable removes git directory but preserves settings', async () => {
    const root = getWorkspaceRoot();
    const hunktrackerDir = path.join(root, '.vscode', 'hunktracker');
    const gitDir = path.join(hunktrackerDir, 'git');
    const settingsPath = path.join(hunktrackerDir, 'settings.json');

    await enableHunktracker();
    assert.ok(fs.existsSync(gitDir), 'Git dir should exist after enable');
    assert.ok(fs.existsSync(settingsPath), 'Settings should exist');

    await disableHunktracker();

    assert.ok(!fs.existsSync(gitDir), 'Git dir should be removed after disable');
    // Settings file is preserved so re-enable remembers user preferences
    assert.ok(fs.existsSync(settingsPath), 'Settings should be preserved after disable');
  });

  test('enable-disable-enable cycle works cleanly', async () => {
    const root = getWorkspaceRoot();
    writeFileExternally(path.join(root, 'cycle.txt'), 'cycle content\n');

    // First enable
    await enableHunktracker();
    await waitForCondition(() => gitListTracked(root).includes('cycle.txt'), 5000);

    // Disable
    await disableHunktracker();

    // Second enable
    await enableHunktracker();
    await waitForCondition(() => gitListTracked(root).includes('cycle.txt'), 5000);

    const baseline = gitGetBaseline(root, 'cycle.txt');
    assert.strictEqual(baseline, 'cycle content\n', 'Baseline should match file content after re-enable');
  });

  test('enable does not create or modify .gitignore', async () => {
    const root = getWorkspaceRoot();
    const gitignorePath = path.join(root, '.gitignore');

    assert.ok(!fs.existsSync(gitignorePath), '.gitignore should not exist initially');

    await enableHunktracker();

    assert.ok(!fs.existsSync(gitignorePath), '.gitignore should not be created by enable');
  });

  test('setIgnorePatterns persists to settings.json', async () => {
    const root = getWorkspaceRoot();
    const settingsPath = path.join(root, '.vscode', 'hunktracker', 'settings.json');

    await enableHunktracker();

    await vscode.commands.executeCommand('hunktracker.setIgnorePatterns', ['.git', 'node_modules', '*.tmp']);
    await sleep(200);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.deepStrictEqual(settings.ignorePatterns, ['.git', 'node_modules', '*.tmp']);
  });

  test('setRespectGitignore persists to settings.json', async () => {
    const root = getWorkspaceRoot();
    const settingsPath = path.join(root, '.vscode', 'hunktracker', 'settings.json');

    await enableHunktracker();

    await vscode.commands.executeCommand('hunktracker.setRespectGitignore', false);
    await sleep(200);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(settings.respectGitignore, false);
  });

  test('setClearOnBranchSwitch persists to settings.json', async () => {
    const root = getWorkspaceRoot();
    const settingsPath = path.join(root, '.vscode', 'hunktracker', 'settings.json');

    await enableHunktracker();

    await vscode.commands.executeCommand('hunktracker.setClearOnBranchSwitch', true);
    await sleep(200);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(settings.clearOnBranchSwitch, true);
  });

  test('clearHunks command clears reviewing files and updates baselines', async () => {
    const root = getWorkspaceRoot();

    // Create a file, enable hunktracker (snapshots baseline), then modify externally
    writeFileExternally(path.join(root, 'hello.txt'), 'original\n');
    await enableHunktracker();
    await waitForCondition(() => gitListTracked(root).includes('hello.txt'));

    // Modify externally to enter reviewing state
    writeFileExternally(path.join(root, 'hello.txt'), 'modified\n');
    await sleep(1000); // wait for file watcher to detect change and enter reviewing

    // Verify baseline is still original
    assert.strictEqual(gitGetBaseline(root, 'hello.txt'), 'original\n');

    // Now clear hunks (simulates branch switch)
    await vscode.commands.executeCommand('hunktracker.clearHunks');
    await sleep(500);

    // Verify: baseline updated to current disk content
    const baseline = gitGetBaseline(root, 'hello.txt');
    assert.strictEqual(baseline, 'modified\n', 'baseline should be updated to current disk content');
  });

  test('default ignorePatterns exclude .git files from tracking', async () => {
    const root = getWorkspaceRoot();

    // The workspace is a real git repo (see .vscode-test.mjs): add a file inside .git, with a name
    // that cannot clobber anything git itself uses, and remove it again afterwards
    const gitFile = path.join(root, '.git', 'hunktracker-ignored-test.txt');
    writeFileExternally(gitFile, 'inside .git\n');

    try {
      // Create a normal file
      writeFileExternally(path.join(root, 'normal.txt'), 'normal\n');

      await enableHunktracker();

      await waitForCondition(() => gitListTracked(root).includes('normal.txt'), 5000);
      await sleep(300);

      const tracked = gitListTracked(root);
      assert.ok(tracked.includes('normal.txt'), 'Normal file should be tracked');
      assert.ok(!tracked.includes('.git/hunktracker-ignored-test.txt'), '.git files should be ignored');
    } finally {
      fs.rmSync(gitFile, { force: true });
    }
  });
});
