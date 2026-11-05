import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, getDataDir, gitListTracked, gitGetBaseline,
  sleep, waitForCondition, enableHunktracker, disableHunktracker,
  writeFileExternally, cleanWorkspace, getStateManager,
  assertThrowawayRepo, repoGit,
} from './helpers';

// ── Test suite ────────────────────────────────────────────────────────────────

suite('hunktracker clearOnBranchSwitch integration', function () {
  this.timeout(30000);

  setup(async function () {
    await cleanWorkspace();
  });

  teardown(async function () {
    try { await disableHunktracker(); } catch { /* ignore */ }
    await cleanWorkspace();
  });

  test('clearHunks clears multiple reviewing files and updates all baselines', async () => {
    const root = getWorkspaceRoot();

    // Create multiple files
    writeFileExternally(path.join(root, 'a.txt'), 'original-a\n');
    writeFileExternally(path.join(root, 'b.txt'), 'original-b\n');
    writeFileExternally(path.join(root, 'c.txt'), 'original-c\n');

    await enableHunktracker();
    await waitForCondition(() => gitListTracked(root).includes('a.txt'));
    await waitForCondition(() => gitListTracked(root).includes('b.txt'));
    await waitForCondition(() => gitListTracked(root).includes('c.txt'));

    // Modify all files externally to enter reviewing state
    writeFileExternally(path.join(root, 'a.txt'), 'modified-a\n');
    writeFileExternally(path.join(root, 'b.txt'), 'modified-b\n');
    writeFileExternally(path.join(root, 'c.txt'), 'modified-c\n');
    await sleep(1500);

    // Verify baselines are still original
    assert.strictEqual(gitGetBaseline(root, 'a.txt'), 'original-a\n');
    assert.strictEqual(gitGetBaseline(root, 'b.txt'), 'original-b\n');
    assert.strictEqual(gitGetBaseline(root, 'c.txt'), 'original-c\n');

    // Verify files are in reviewing state
    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    const allFiles = sm.getAllFiles() as Map<string, any>;
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      const state = allFiles.get(path.join(root, name));
      assert.ok(state && state.status === 'reviewing',
        `${name} should be in reviewing state`);
    }

    // Clear hunks (simulates branch switch)
    await vscode.commands.executeCommand('hunktracker.clearHunks');
    await sleep(500);

    // All baselines should be updated to current disk content
    assert.strictEqual(gitGetBaseline(root, 'a.txt'), 'modified-a\n');
    assert.strictEqual(gitGetBaseline(root, 'b.txt'), 'modified-b\n');
    assert.strictEqual(gitGetBaseline(root, 'c.txt'), 'modified-c\n');

    // No files should be in reviewing state
    const allFilesAfter = sm.getAllFiles() as Map<string, any>;
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      const state = allFilesAfter.get(path.join(root, name));
      assert.ok(!state || state.status !== 'reviewing',
        `${name} should NOT be in reviewing state after clearHunks`);
    }
  });

  test('clearHunks removes deleted files from tracking', async () => {
    const root = getWorkspaceRoot();

    // Create a file, enable, snapshot baseline
    writeFileExternally(path.join(root, 'doomed.txt'), 'will be deleted\n');
    writeFileExternally(path.join(root, 'survives.txt'), 'original\n');

    await enableHunktracker();
    await waitForCondition(() => gitListTracked(root).includes('doomed.txt'));
    await waitForCondition(() => gitListTracked(root).includes('survives.txt'));

    // Modify survives.txt to enter reviewing
    writeFileExternally(path.join(root, 'survives.txt'), 'modified\n');
    await sleep(1500);

    // Delete doomed.txt externally — FileWatcher should detect deletion and enter reviewing
    fs.unlinkSync(path.join(root, 'doomed.txt'));
    await sleep(1500);

    // Now clear hunks
    await vscode.commands.executeCommand('hunktracker.clearHunks');
    await sleep(500);

    // doomed.txt should be removed from git tracking (file doesn't exist)
    const tracked = gitListTracked(root);
    assert.ok(!tracked.includes('doomed.txt'),
      'deleted file should be removed from tracking after clearHunks');

    // survives.txt baseline should be updated
    assert.strictEqual(gitGetBaseline(root, 'survives.txt'), 'modified\n');
  });

  test('clearHunks with no reviewing files is a no-op', async () => {
    const root = getWorkspaceRoot();

    // Create a file but don't modify it (stays idle, not reviewing)
    writeFileExternally(path.join(root, 'idle.txt'), 'idle content\n');

    await enableHunktracker();
    await waitForCondition(() => gitListTracked(root).includes('idle.txt'));

    const baselineBefore = gitGetBaseline(root, 'idle.txt');

    // Clear hunks — nothing should change
    await vscode.commands.executeCommand('hunktracker.clearHunks');
    await sleep(300);

    const baselineAfter = gitGetBaseline(root, 'idle.txt');
    assert.strictEqual(baselineAfter, baselineBefore,
      'baseline should not change when no files are reviewing');
  });

  test('clearHunks only affects reviewing files, not idle files', async () => {
    const root = getWorkspaceRoot();

    writeFileExternally(path.join(root, 'idle.txt'), 'idle\n');
    writeFileExternally(path.join(root, 'active.txt'), 'original\n');

    await enableHunktracker();
    await waitForCondition(() => gitListTracked(root).includes('idle.txt'));
    await waitForCondition(() => gitListTracked(root).includes('active.txt'));

    // Only modify active.txt to enter reviewing
    writeFileExternally(path.join(root, 'active.txt'), 'changed\n');
    await sleep(1500);

    // Verify only active.txt is reviewing
    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    const files = sm.getAllFiles() as Map<string, any>;
    const idleState = files.get(path.join(root, 'idle.txt'));
    const activeState = files.get(path.join(root, 'active.txt'));
    assert.ok(!idleState || idleState.status !== 'reviewing', 'idle.txt should not be reviewing');
    assert.ok(activeState && activeState.status === 'reviewing', 'active.txt should be reviewing');

    // Clear hunks
    await vscode.commands.executeCommand('hunktracker.clearHunks');
    await sleep(500);

    // idle.txt baseline should be unchanged
    assert.strictEqual(gitGetBaseline(root, 'idle.txt'), 'idle\n');
    // active.txt baseline should be updated
    assert.strictEqual(gitGetBaseline(root, 'active.txt'), 'changed\n');
  });

  test('setClearOnBranchSwitch persists and can be toggled', async () => {
    const root = getWorkspaceRoot();
    const settingsPath = path.join(getDataDir(), 'settings.json');

    await enableHunktracker();

    // Default should be false
    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    assert.strictEqual(sm.clearOnBranchSwitch, false,
      'clearOnBranchSwitch should default to false');

    // Set to true
    await vscode.commands.executeCommand('hunktracker.setClearOnBranchSwitch', true);
    await sleep(200);

    let settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(settings.clearOnBranchSwitch, true);
    assert.strictEqual(sm.clearOnBranchSwitch, true);

    // Toggle back to false
    await vscode.commands.executeCommand('hunktracker.setClearOnBranchSwitch', false);
    await sleep(200);

    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(settings.clearOnBranchSwitch, false);
    assert.strictEqual(sm.clearOnBranchSwitch, false);
  });

  test('clearOnBranchSwitch setting survives disable-enable cycle', async () => {
    const root = getWorkspaceRoot();
    const settingsPath = path.join(getDataDir(), 'settings.json');

    await enableHunktracker();

    // Set clearOnBranchSwitch to true
    await vscode.commands.executeCommand('hunktracker.setClearOnBranchSwitch', true);
    await sleep(200);

    // Disable and re-enable
    await disableHunktracker();
    await enableHunktracker();

    // Setting should be preserved
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(settings.clearOnBranchSwitch, true,
      'clearOnBranchSwitch should persist across disable-enable cycle');

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    assert.strictEqual(sm.clearOnBranchSwitch, true,
      'in-memory clearOnBranchSwitch should be restored after re-enable');
  });

  // The workspace is a throwaway git repo (created by .vscode-test.mjs before VS Code starts, so the
  // extension's .git/HEAD watcher exists from activation). This runs a real `git switch`.
  test('a real git branch switch clears hunks and re-syncs baselines', async function () {
    const root = getWorkspaceRoot();
    assertThrowawayRepo(root);

    // `main` and `other` hold different versions of the same tracked file
    const branchFile = path.join(root, 'branch-test.txt');
    writeFileExternally(branchFile, 'main version\n');
    repoGit(root, 'add', 'branch-test.txt');
    repoGit(root, 'commit', '-q', '-m', 'main version');
    repoGit(root, 'switch', '-q', '-c', 'other');
    writeFileExternally(branchFile, 'other version\n');
    repoGit(root, 'commit', '-q', '-am', 'other version');
    repoGit(root, 'switch', '-q', 'main');

    // A second file, not part of the test repo, that will have a pending change at switch time
    const pendingFile = path.join(root, 'pending.txt');
    writeFileExternally(pendingFile, 'base\n');

    try {
      await enableHunktracker();
      await waitForCondition(() => gitListTracked(root).includes('branch-test.txt'));
      await waitForCondition(() => gitListTracked(root).includes('pending.txt'));
      assert.strictEqual(gitGetBaseline(root, 'branch-test.txt'), 'main version\n');

      await vscode.commands.executeCommand('hunktracker.setClearOnBranchSwitch', true);
      await sleep(200);

      // An external change puts pending.txt into review
      writeFileExternally(pendingFile, 'changed\n');
      const sm = getStateManager();
      assert.ok(sm, 'StateManager should be available');
      const status = (fp: string) => (sm.getAllFiles() as Map<string, any>).get(fp)?.status;
      await waitForCondition(() => status(pendingFile) === 'reviewing');

      // The branch switch rewrites .git/HEAD and branch-test.txt on disk, as users do
      repoGit(root, 'switch', '-q', 'other');
      assert.strictEqual(fs.readFileSync(branchFile, 'utf-8'), 'other version\n', 'git switch should rewrite the file');

      // The HEAD watcher should clear review state and re-sync every baseline to the disk content
      await waitForCondition(
        () => gitGetBaseline(root, 'branch-test.txt') === 'other version\n' && status(pendingFile) !== 'reviewing',
        8000
      );
      assert.notStrictEqual(status(branchFile), 'reviewing', 'the switched file must not show as an external change');
      assert.strictEqual(gitGetBaseline(root, 'pending.txt'), 'changed\n',
        'pending change should be adopted as the new baseline');
    } finally {
      // Disable first: switching back would otherwise trigger another clear
      try { await disableHunktracker(); } catch { /* ignore */ }
      try { repoGit(root, 'switch', '-q', '-f', 'main'); } catch { /* ignore */ }
    }
  });
});
