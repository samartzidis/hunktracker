import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, getDataDir, gitListTracked, gitGetBaseline,
  sleep, waitForCondition, enableHunktracker, disableHunktracker,
  writeFileExternally, cleanWorkspace, getStateManager, getFileWatcher,
  relPath,
} from './helpers';

// ── Test suite ────────────────────────────────────────────────────────────────

suite('hunktracker file watcher integration', function () {
  this.timeout(30000);

  setup(async function () {
    await cleanWorkspace();
  });

  teardown(async function () {
    try { await disableHunktracker(); } catch { /* ignore */ }
    await cleanWorkspace();
  });

  test('enable snapshots existing files as baselines', async () => {
    const root = getWorkspaceRoot();

    // Create files before enabling
    const fileA = path.join(root, 'a.txt');
    const fileB = path.join(root, 'sub', 'b.txt');
    writeFileExternally(fileA, 'content a\n');
    writeFileExternally(fileB, 'content b\n');

    await enableHunktracker();

    const relA = relPath(root, fileA);
    const relB = relPath(root, fileB);

    await waitForCondition(() => {
      const tracked = gitListTracked(root);
      return tracked.includes(relA) && tracked.includes(relB);
    }, 8000);

    // Baselines should match file contents
    assert.strictEqual(gitGetBaseline(root, relA), 'content a\n');
    assert.strictEqual(gitGetBaseline(root, relB), 'content b\n');
  });

  test('paths outside the workspace folder are ignored', async () => {
    const root = getWorkspaceRoot();
    await enableHunktracker();

    const fw = getFileWatcher();
    assert.ok(fw, 'FileWatcher should be available');

    const outside = path.join(path.dirname(root), 'hunktracker-outside-file.txt');
    assert.strictEqual(fw.shouldIgnore(outside), true, 'sibling of the workspace root should be ignored');
    assert.strictEqual(fw.shouldIgnore(path.join(root, 'inside.txt')), false, 'file inside the root should not be ignored');
  });

  test('disable clears all state and removes git directory', async () => {
    const root = getWorkspaceRoot();

    writeFileExternally(path.join(root, 'file.txt'), 'hello\n');
    await enableHunktracker();

    const gitDir = path.join(getDataDir(), 'git');
    await waitForCondition(() => fs.existsSync(gitDir), 5000);

    await disableHunktracker();

    // Git dir should be removed
    assert.ok(!fs.existsSync(gitDir), 'Git directory should be removed after disable');
  });

  test('external file creation is tracked with null baseline (not in git)', async () => {
    const root = getWorkspaceRoot();
    await enableHunktracker();

    // Create a file externally after enable
    const filePath = path.join(root, 'new-external.txt');
    writeFileExternally(filePath, 'external content\n');

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');

    // Wait for FileWatcher to detect and enter reviewing
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 8000);

    // For external new files, baseline should be null (file didn't exist before)
    // null-baseline files are NOT stored in git
    const fileState = sm.getFile(filePath);
    assert.strictEqual(fileState?.baseline, null, 'External new file should have null baseline');
    const rel = relPath(root, filePath);
    const gitBaseline = gitGetBaseline(root, rel);
    assert.strictEqual(gitBaseline, undefined, 'Null-baseline files should not be in git');
  });

  test('external file modification preserves original baseline', async () => {
    const root = getWorkspaceRoot();

    // Create file before enable → becomes baseline
    const filePath = path.join(root, 'modify-me.txt');
    writeFileExternally(filePath, 'original\n');

    await enableHunktracker();

    const rel = relPath(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);

    const baselineBefore = gitGetBaseline(root, rel)!;
    assert.strictEqual(baselineBefore, 'original\n');

    // Externally modify the file
    writeFileExternally(filePath, 'original\nmodified\n');
    await sleep(500);

    // Baseline should remain the original content
    const baselineAfter = gitGetBaseline(root, rel);
    assert.strictEqual(baselineAfter, 'original\n', 'Baseline should be preserved after external modification');
  });

  test('external file deletion of new file (null baseline) cleans up state', async () => {
    const root = getWorkspaceRoot();
    await enableHunktracker();

    // Create a file externally → null baseline (new file, not in git)
    const filePath = path.join(root, 'will-delete.txt');
    writeFileExternally(filePath, 'temp content\n');

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 8000);

    // Delete the file externally
    fs.unlinkSync(filePath);

    // State should be cleaned up (null baseline file deleted → remove from tracking)
    await waitForCondition(() => !sm.getFile(filePath), 5000);
    assert.ok(!fs.existsSync(filePath), 'File should not exist on disk after deletion');
    assert.ok(!sm.getFile(filePath), 'File should be removed from state');
  });

  test('re-enable after disable restores fresh state', async () => {
    const root = getWorkspaceRoot();

    writeFileExternally(path.join(root, 'persist.txt'), 'persist\n');

    await enableHunktracker();
    const rel = 'persist.txt';
    await waitForCondition(() => gitListTracked(root).includes(rel), 5000);

    await disableHunktracker();

    // Modify the file while disabled
    writeFileExternally(path.join(root, 'persist.txt'), 'modified while disabled\n');

    // Re-enable
    await enableHunktracker();
    await waitForCondition(() => gitListTracked(root).includes(rel), 5000);

    // Baseline should be the current content (since we re-snapshotted)
    const baseline = gitGetBaseline(root, rel);
    assert.strictEqual(baseline, 'modified while disabled\n',
      'After re-enable, baseline should reflect current file content');
  });

  test('multiple files created simultaneously are all tracked in memory', async () => {
    const root = getWorkspaceRoot();
    await enableHunktracker();

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');

    // Create several files at once
    const files = ['f1.txt', 'f2.txt', 'f3.txt', 'dir/f4.txt', 'dir/sub/f5.txt'];
    for (const f of files) {
      writeFileExternally(path.join(root, f), `content of ${f}\n`);
    }

    // New files have null baseline → tracked in memory, not in git
    await waitForCondition(() => {
      return files.every(f => {
        const state = sm.getFile(path.join(root, f));
        return state?.status === 'reviewing';
      });
    }, 8000);

    for (const f of files) {
      const state = sm.getFile(path.join(root, f));
      assert.ok(state, `"${f}" should be in state`);
      assert.strictEqual(state?.baseline, null, `"${f}" should have null baseline (new file)`);
    }
  });

  test('refresh preserves externally created new files (null baseline)', async () => {
    const root = getWorkspaceRoot();
    await enableHunktracker();

    // Create a file externally after enable — simulates Finder drag-in
    const filePath = path.join(root, 'finder-file.txt');
    writeFileExternally(filePath, 'dragged in from Finder\n');

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');

    // Wait for FileWatcher to detect and enter reviewing with null baseline
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing' && f?.baseline === null;
    }, 8000);

    // Execute the refresh command (same as clicking the refresh button in the panel)
    await vscode.commands.executeCommand('hunktracker.refresh');

    // After refresh, the new file should still be in reviewing state with null baseline
    const fileState = sm.getFile(filePath);
    assert.ok(fileState, 'New file should still exist in state after refresh');
    assert.strictEqual(fileState?.status, 'reviewing', 'New file should still be reviewing after refresh');
    assert.strictEqual(fileState?.baseline, null, 'New file should still have null baseline after refresh');
  });

  test('refresh preserves binary files detected by FileWatcher as new', async () => {
    const root = getWorkspaceRoot();
    await enableHunktracker();

    // Create a binary file externally (e.g. .xlsx dragged from Finder)
    const binaryFile = path.join(root, 'report.xlsx');
    const binaryContent = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00]);
    fs.writeFileSync(binaryFile, binaryContent);

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');

    // Wait for FileWatcher to detect and enter reviewing with null baseline
    await waitForCondition(() => {
      const f = sm.getFile(binaryFile);
      return f?.status === 'reviewing' && f?.baseline === null;
    }, 8000);

    // Execute refresh
    await vscode.commands.executeCommand('hunktracker.refresh');

    // Binary file should STILL be in state — consistent with onDiskCreate behavior
    const fileState = sm.getFile(binaryFile);
    assert.ok(fileState, 'Binary file should still exist in state after refresh');
    assert.strictEqual(fileState?.status, 'reviewing', 'Binary file should still be reviewing');
    assert.strictEqual(fileState?.baseline, null, 'Binary file should still have null baseline');
  });

  test('externally created empty files enter reviewing with null baseline', async () => {
    const root = getWorkspaceRoot();
    await enableHunktracker();

    const emptyFile = path.join(root, 'empty.txt');
    writeFileExternally(emptyFile, '');

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');

    // Empty files created externally should now be tracked as new files
    await waitForCondition(() => {
      const f = sm.getFile(emptyFile);
      return f?.status === 'reviewing';
    }, 5000);

    const fileState = sm.getFile(emptyFile);
    assert.strictEqual(fileState?.baseline, null, 'Empty new file should have null baseline');
    // Null-baseline files are not stored in git
    const rel = relPath(root, emptyFile);
    assert.strictEqual(gitGetBaseline(root, rel), undefined, 'Null-baseline files should not be in git');
  });

  // Writing a new file raises a create and a change event, handled concurrently. If the change handler
  // is still waiting for the baseline lookup when the create handler has already put the file into
  // review, it used to adopt the content as the baseline, and the next refresh dropped the file from
  // review. Seen as a flake in the two "refresh preserves ..." tests; this drives the order directly.
  test('a change event racing a create event does not adopt a new file as its baseline', async () => {
    const root = getWorkspaceRoot();
    await enableHunktracker();

    const sm = getStateManager();
    const fw = getFileWatcher();
    assert.ok(sm && fw, 'StateManager and FileWatcher should be available');
    const git = sm.git;
    assert.ok(git, 'hunktracker git should be available');

    // Write the file with the watcher suppressed so its natural events are dropped; the handlers
    // are then called by hand, in the order that goes wrong in real use.
    const filePath = path.join(root, 'race-file.txt');
    fw.suppressAll();
    try {
      writeFileExternally(filePath, 'new content\n');
      await sleep(700);
    } finally {
      fw.resumeAll();
    }
    assert.ok(!sm.getFile(filePath), 'precondition: file is not tracked yet');

    // Hold the first baseline lookup (the change handler's) until the create handler has finished
    const realGetBaseline = git.getBaseline.bind(git);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    git.getBaseline = async (fp: string) => {
      if (!held) { held = true; await gate; }
      return realGetBaseline(fp);
    };

    try {
      const uri = vscode.Uri.file(filePath);
      const changeDone = fw.onDiskChange(uri);
      await waitForCondition(() => held);

      await fw.onDiskCreate(uri);
      assert.strictEqual(sm.getFile(filePath)?.status, 'reviewing', 'create handler should enter review');
      assert.strictEqual(sm.getFile(filePath)?.baseline, null, 'as a new file');

      release();
      await changeDone;
      await sm.flush();

      assert.strictEqual(sm.getFile(filePath)?.status, 'reviewing', 'file must still be in review');
      assert.strictEqual(sm.getFile(filePath)?.baseline, null, 'file must still be new');
      assert.strictEqual(gitGetBaseline(root, relPath(root, filePath)), undefined,
        'content must not have been adopted as a baseline');
    } finally {
      release();
      delete git.getBaseline; // back to the prototype method
    }
  });

  test('a tracked file that grows past the size limit is forgotten: no pending changes, no baseline', async () => {
    const root = getWorkspaceRoot();
    const fp = path.join(root, 'grows-past-limit.log');
    writeFileExternally(fp, 'line 1\n');
    await enableHunktracker();
    await waitForCondition(() => gitListTracked(root).includes('grows-past-limit.log'), 8000);

    // a small external change first: the file has pending changes
    writeFileExternally(fp, 'line 1\nline 2\n');
    await waitForCondition(() => getStateManager().getFile(fp)?.status === 'reviewing', 8000);

    // then it grows past 10 MB (a log file, a dump...)
    writeFileExternally(fp, 'x'.repeat(10 * 1024 * 1024 + 10));
    await waitForCondition(() => getStateManager().getFile(fp) === undefined, 10000, 200);
    await waitForCondition(() => !gitListTracked(root).includes('grows-past-limit.log'), 10000, 200);
  });
});
