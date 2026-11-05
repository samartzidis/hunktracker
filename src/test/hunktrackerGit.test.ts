import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { HunktrackerGit, isGitLockError, parseCatFileBatch } from '../hunktrackerGit';
import { removeDirSync } from '../fsUtil';

let tmpDir: string;
let hunktrackerDir: string;
let git: HunktrackerGit;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-test-'));
  hunktrackerDir = path.join(tmpDir, '.vscode', 'hunktracker');
  git = new HunktrackerGit(hunktrackerDir, tmpDir);
  await git.initGit();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('HunktrackerGit', () => {
  describe('initGit', () => {
    it('creates the git directory', () => {
      assert.ok(fs.existsSync(path.join(hunktrackerDir, 'git')));
    });

    it('is idempotent — calling twice does not throw', async () => {
      await git.initGit();
      assert.ok(fs.existsSync(path.join(hunktrackerDir, 'git')));
    });
  });

  describe('snapshot / getBaseline', () => {
    it('returns undefined for untracked file', async () => {
      const result = await git.getBaseline(path.join(tmpDir, 'nonexistent.txt'));
      assert.equal(result, undefined);
    });

    it('stores and retrieves content', async () => {
      const filePath = path.join(tmpDir, 'hello.txt');
      await git.snapshot(filePath, 'hello world\n');
      const baseline = await git.getBaseline(filePath);
      assert.equal(baseline, 'hello world\n');
    });

    it('overwrites previous snapshot', async () => {
      const filePath = path.join(tmpDir, 'update.txt');
      await git.snapshot(filePath, 'v1\n');
      await git.snapshot(filePath, 'v2\n');
      const baseline = await git.getBaseline(filePath);
      assert.equal(baseline, 'v2\n');
    });

    it('handles empty content', async () => {
      const filePath = path.join(tmpDir, 'empty.txt');
      await git.snapshot(filePath, '');
      const baseline = await git.getBaseline(filePath);
      assert.equal(baseline, '');
    });

    it('handles multi-line content', async () => {
      const filePath = path.join(tmpDir, 'multi.txt');
      const content = 'line1\nline2\nline3\n';
      await git.snapshot(filePath, content);
      assert.equal(await git.getBaseline(filePath), content);
    });

    it('handles content with special characters', async () => {
      const filePath = path.join(tmpDir, 'special.txt');
      const content = 'hello "world" & <foo>\n';
      await git.snapshot(filePath, content);
      assert.equal(await git.getBaseline(filePath), content);
    });
  });

  describe('snapshotBatch', () => {
    it('snapshots multiple files atomically', async () => {
      const files = [
        { filePath: path.join(tmpDir, 'batch1.txt'), content: 'batch1\n' },
        { filePath: path.join(tmpDir, 'batch2.txt'), content: 'batch2\n' },
        { filePath: path.join(tmpDir, 'batch3.txt'), content: 'batch3\n' },
      ];
      await git.snapshotBatch(files);
      for (const { filePath, content } of files) {
        assert.equal(await git.getBaseline(filePath), content);
      }
    });

    it('is a no-op for empty array', async () => {
      await git.snapshotBatch([]);
    });

    it('getBaseline is immediately available after snapshotBatch', async () => {
      const filePath = path.join(tmpDir, 'immediate.txt');
      await git.snapshotBatch([{ filePath, content: 'immediate\n' }]);
      // Must be readable right away without any extra commit
      assert.equal(await git.getBaseline(filePath), 'immediate\n');
    });

    it('snapshot after snapshotBatch does not lose batch files from HEAD', async () => {
      // Reproduce: snapshotBatch adds fileA, then snapshot adds fileB.
      // After both commits, fileA must still be in HEAD (listTrackedFiles).
      const fileA = path.join(tmpDir, 'batch-persist-a.txt');
      const fileB = path.join(tmpDir, 'batch-persist-b.txt');
      await git.snapshotBatch([{ filePath: fileA, content: 'aaa\n' }]);
      await git.snapshot(fileB, 'bbb\n');
      const tracked = await git.listTrackedFiles();
      assert.ok(tracked.includes(fileA), `fileA should be in HEAD after subsequent snapshot (tracked: ${tracked.join(', ')})`);
      assert.ok(tracked.includes(fileB), `fileB should be in HEAD`);
      assert.equal(await git.getBaseline(fileA), 'aaa\n');
      assert.equal(await git.getBaseline(fileB), 'bbb\n');
    });

    it('snapshotBatch after snapshotBatch preserves all files in HEAD', async () => {
      const fileC = path.join(tmpDir, 'batch2-c.txt');
      const fileD = path.join(tmpDir, 'batch2-d.txt');
      await git.snapshotBatch([{ filePath: fileC, content: 'ccc\n' }]);
      await git.snapshotBatch([{ filePath: fileD, content: 'ddd\n' }]);
      const tracked = await git.listTrackedFiles();
      assert.ok(tracked.includes(fileC), 'fileC from first batch should persist after second batch');
      assert.ok(tracked.includes(fileD), 'fileD from second batch should be present');
    });
  });

  describe('removeFile', () => {
    it('removes a tracked file', async () => {
      const filePath = path.join(tmpDir, 'toremove.txt');
      await git.snapshot(filePath, 'remove me\n');
      assert.notEqual(await git.getBaseline(filePath), undefined);
      await git.removeFile(filePath);
      assert.equal(await git.getBaseline(filePath), undefined);
    });

    it('is a no-op for untracked file', async () => {
      const filePath = path.join(tmpDir, 'never-tracked.txt');
      await git.removeFile(filePath); // should not throw
    });
  });

  describe('removeFileBatch', () => {
    it('removes multiple tracked files in one operation', async () => {
      const file1 = path.join(tmpDir, 'batch-rm-1.txt');
      const file2 = path.join(tmpDir, 'batch-rm-2.txt');
      const file3 = path.join(tmpDir, 'batch-rm-3.txt');
      await git.snapshotBatch([
        { filePath: file1, content: 'a\n' },
        { filePath: file2, content: 'b\n' },
        { filePath: file3, content: 'c\n' },
      ]);
      assert.equal(await git.getBaseline(file1), 'a\n');
      assert.equal(await git.getBaseline(file2), 'b\n');
      assert.equal(await git.getBaseline(file3), 'c\n');
      await git.removeFileBatch([file1, file2, file3]);
      assert.equal(await git.getBaseline(file1), undefined);
      assert.equal(await git.getBaseline(file2), undefined);
      assert.equal(await git.getBaseline(file3), undefined);
    });

    it('is a no-op for empty array', async () => {
      await git.removeFileBatch([]); // should not throw
    });

    it('leaves unrelated files intact', async () => {
      const keep = path.join(tmpDir, 'batch-rm-keep.txt');
      const remove = path.join(tmpDir, 'batch-rm-gone.txt');
      await git.snapshotBatch([
        { filePath: keep, content: 'keep\n' },
        { filePath: remove, content: 'gone\n' },
      ]);
      await git.removeFileBatch([remove]);
      assert.equal(await git.getBaseline(keep), 'keep\n');
      assert.equal(await git.getBaseline(remove), undefined);
    });
  });

  describe('renameFile', () => {
    it('moves baseline from old path to new path', async () => {
      const oldPath = path.join(tmpDir, 'rename-old.txt');
      const newPath = path.join(tmpDir, 'rename-new.txt');
      await git.snapshot(oldPath, 'rename content\n');
      await git.renameFile(oldPath, newPath);
      assert.equal(await git.getBaseline(newPath), 'rename content\n');
      assert.equal(await git.getBaseline(oldPath), undefined);
    });

    it('preserves content for a file that was already reviewing', async () => {
      const oldPath = path.join(tmpDir, 'reviewing-old.txt');
      const newPath = path.join(tmpDir, 'reviewing-new.txt');
      const content = 'line1\nline2\nline3\n';
      await git.snapshot(oldPath, content);
      await git.renameFile(oldPath, newPath);
      assert.equal(await git.getBaseline(newPath), content);
    });

    it('works for new file (empty baseline)', async () => {
      const oldPath = path.join(tmpDir, 'new-old.txt');
      const newPath = path.join(tmpDir, 'new-new.txt');
      await git.snapshot(oldPath, '');
      await git.renameFile(oldPath, newPath);
      assert.equal(await git.getBaseline(newPath), '');
      assert.equal(await git.getBaseline(oldPath), undefined);
    });

    it('is a no-op for untracked file', async () => {
      const oldPath = path.join(tmpDir, 'untracked-rename.txt');
      const newPath = path.join(tmpDir, 'untracked-rename-new.txt');
      await git.renameFile(oldPath, newPath); // should not throw
      assert.equal(await git.getBaseline(newPath), undefined);
    });

    it('does not affect other tracked files', async () => {
      const other = path.join(tmpDir, 'rename-other.txt');
      const oldPath = path.join(tmpDir, 'rename-move-old.txt');
      const newPath = path.join(tmpDir, 'rename-move-new.txt');
      await git.snapshot(other, 'other\n');
      await git.snapshot(oldPath, 'moving\n');
      await git.renameFile(oldPath, newPath);
      assert.equal(await git.getBaseline(other), 'other\n');
      assert.equal(await git.getBaseline(newPath), 'moving\n');
    });

    it('renamed file appears in listTrackedFiles with new path', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-rename-list-'));
      const g2 = new HunktrackerGit(path.join(dir2, '.vscode', 'hunktracker'), dir2);
      await g2.initGit();
      const oldPath = path.join(dir2, 'a.txt');
      const newPath = path.join(dir2, 'b.txt');
      await g2.snapshot(oldPath, 'content\n');
      await g2.renameFile(oldPath, newPath);
      const tracked = await g2.listTrackedFiles();
      assert.ok(tracked.includes(newPath));
      assert.ok(!tracked.includes(oldPath));
      fs.rmSync(dir2, { recursive: true, force: true });
    });
  });

  describe('listTrackedFiles', () => {
    it('returns empty when nothing tracked', async () => {
      // fresh instance to avoid interference
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-list-'));
      const g2 = new HunktrackerGit(path.join(dir2, '.vscode', 'hunktracker'), dir2);
      await g2.initGit();
      const files = await g2.listTrackedFiles();
      assert.deepEqual(files, []);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('returns tracked file paths', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-list2-'));
      const root = dir2;
      const g2 = new HunktrackerGit(path.join(dir2, '.vscode', 'hunktracker'), root);
      await g2.initGit();
      const f1 = path.join(root, 'a.txt');
      const f2 = path.join(root, 'b.txt');
      await g2.snapshotBatch([
        { filePath: f1, content: 'a\n' },
        { filePath: f2, content: 'b\n' },
      ]);
      const tracked = await g2.listTrackedFiles();
      assert.ok(tracked.includes(f1));
      assert.ok(tracked.includes(f2));
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('handles non-ASCII file paths correctly', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-nonascii-'));
      const root = dir2;
      const g2 = new HunktrackerGit(path.join(dir2, '.vscode', 'hunktracker'), root);
      await g2.initGit();
      const f1 = path.join(root, 'メール一覧.xlsx');
      const f2 = path.join(root, 'sub', '日本語ファイル.txt');
      fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
      await g2.snapshotBatch([
        { filePath: f1, content: 'content1\n' },
        { filePath: f2, content: 'content2\n' },
      ]);
      const tracked = await g2.listTrackedFiles();
      assert.ok(tracked.includes(f1), `tracked should include ${f1}, got: ${tracked}`);
      assert.ok(tracked.includes(f2), `tracked should include ${f2}, got: ${tracked}`);
      // getBaseline should also work with non-ASCII paths
      const baseline = await g2.getBaseline(f1);
      assert.strictEqual(baseline, 'content1\n');
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('renameFile handles directory renames', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-dirren-'));
      const root = dir2;
      const g2 = new HunktrackerGit(path.join(dir2, '.vscode', 'hunktracker'), root);
      await g2.initGit();
      const oldDir = path.join(root, 'oldDir');
      const newDir = path.join(root, 'newDir');
      fs.mkdirSync(oldDir, { recursive: true });
      const f1 = path.join(oldDir, 'a.txt');
      const f2 = path.join(oldDir, 'b.txt');
      await g2.snapshotBatch([
        { filePath: f1, content: 'aaa\n' },
        { filePath: f2, content: 'bbb\n' },
      ]);
      // Rename directory
      await g2.renameFile(oldDir, newDir);
      const tracked = await g2.listTrackedFiles();
      assert.ok(!tracked.some(fp => fp.includes('oldDir')), `no old paths: ${tracked}`);
      assert.ok(tracked.includes(path.join(newDir, 'a.txt')), `tracked a.txt under newDir: ${tracked}`);
      assert.ok(tracked.includes(path.join(newDir, 'b.txt')), `tracked b.txt under newDir: ${tracked}`);
      // Baselines should be accessible under new paths
      assert.strictEqual(await g2.getBaseline(path.join(newDir, 'a.txt')), 'aaa\n');
      assert.strictEqual(await g2.getBaseline(path.join(newDir, 'b.txt')), 'bbb\n');
      fs.rmSync(dir2, { recursive: true, force: true });
    });
  });

  describe('settings', () => {
    it('returns defaults when no settings file exists', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-settings-'));
      const g2 = new HunktrackerGit(path.join(dir2, '.vscode', 'hunktracker'), dir2);
      const s = g2.loadSettings();
      const expectedDefaults = process.platform === 'darwin' ? ['.git', '.DS_Store'] : ['.git'];
      assert.deepEqual(s.ignorePatterns, expectedDefaults);
      assert.equal(s.respectGitignore, true);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('round-trips settings', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-settings2-'));
      const g2 = new HunktrackerGit(path.join(dir2, '.vscode', 'hunktracker'), dir2);
      g2.saveSettings({ ignorePatterns: ['node_modules', 'dist'], respectGitignore: false, clearOnBranchSwitch: false, useDiffEditor: false, showInlineDecorations: true });
      const s = g2.loadSettings();
      assert.deepEqual(s.ignorePatterns, ['node_modules', 'dist']);
      assert.equal(s.respectGitignore, false);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('mergeDefaultSettings fills missing fields', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-merge-'));
      const g2 = new HunktrackerGit(path.join(dir2, '.vscode', 'hunktracker'), dir2);
      // Write partial settings (no respectGitignore)
      fs.mkdirSync(path.join(dir2, '.vscode', 'hunktracker'), { recursive: true });
      fs.writeFileSync(
        path.join(dir2, '.vscode', 'hunktracker', 'settings.json'),
        JSON.stringify({ ignorePatterns: ['dist'] }),
        'utf-8'
      );
      const merged = g2.mergeDefaultSettings({ ignorePatterns: ['.git'], respectGitignore: true, clearOnBranchSwitch: false, useDiffEditor: false, showInlineDecorations: true });
      // Existing value preserved
      assert.deepEqual(merged.ignorePatterns, ['dist']);
      // Missing fields filled from defaults
      assert.equal(merged.respectGitignore, true);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('mergeDefaultSettings preserves all existing fields', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-merge2-'));
      const g2 = new HunktrackerGit(path.join(dir2, '.vscode', 'hunktracker'), dir2);
      g2.saveSettings({ ignorePatterns: ['custom'], respectGitignore: false, clearOnBranchSwitch: false, useDiffEditor: false, showInlineDecorations: true });
      const merged = g2.mergeDefaultSettings({ ignorePatterns: ['.git'], respectGitignore: true, clearOnBranchSwitch: false, useDiffEditor: false, showInlineDecorations: true });
      assert.deepEqual(merged.ignorePatterns, ['custom']);
      assert.equal(merged.respectGitignore, false);
      fs.rmSync(dir2, { recursive: true, force: true });
    });
  });

  describe('git lock contention', () => {
    async function freshGit(): Promise<{ g: HunktrackerGit; dir: string; gitDir: string }> {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-lock-'));
      const hDir = path.join(dir, '.vscode', 'hunktracker');
      const g = new HunktrackerGit(hDir, dir, () => {});
      await g.initGit();
      return { g, dir, gitDir: path.join(hDir, 'git') };
    }

    it('isGitLockError recognises lock failures only', () => {
      assert.equal(isGitLockError(new Error("fatal: Unable to create '/x/git/index.lock': File exists.")), true);
      assert.equal(isGitLockError(new Error("error: cannot lock ref 'HEAD': reference already exists")), true);
      assert.equal(isGitLockError(new Error('fatal: not a git repository')), false);
      assert.equal(isGitLockError('boom'), false);
    });

    it('waits out a lock that is released shortly', async () => {
      const { g, dir, gitDir } = await freshGit();
      try {
        const file = path.join(dir, 'a.txt');
        const lock = path.join(gitDir, 'index.lock');
        fs.writeFileSync(lock, '');
        setTimeout(() => fs.rmSync(lock, { force: true }), 150);
        await g.snapshot(file, 'locked then free\n');
        assert.equal(await g.getBaseline(file), 'locked then free\n');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('batch writes also survive a short-lived lock', async () => {
      const { g, dir, gitDir } = await freshGit();
      try {
        const file = path.join(dir, 'b.txt');
        const lock = path.join(gitDir, 'index.lock');
        fs.writeFileSync(lock, '');
        setTimeout(() => fs.rmSync(lock, { force: true }), 150);
        await g.snapshotBatch([{ filePath: file, content: 'batch\n' }]);
        assert.equal(await g.getBaseline(file), 'batch\n');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('gives up on a lock that never clears, with the lock error', async () => {
      const { g, dir, gitDir } = await freshGit();
      try {
        fs.writeFileSync(path.join(gitDir, 'index.lock'), '');
        await assert.rejects(
          g.snapshot(path.join(dir, 'c.txt'), 'never\n'),
          (err: unknown) => isGitLockError(err)
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('batched operations (a few git processes, not one per file)', () => {
    async function withRepo(fn: (g: HunktrackerGit, root: string, hDir: string) => Promise<void>): Promise<void> {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-batch-'));
      const hDir = path.join(root, '.vscode', 'hunktracker');
      const g = new HunktrackerGit(hDir, root);
      try {
        await g.initGit();
        await fn(g, root, hDir);
      } finally {
        removeDirSync(root);
      }
    }

    describe('parseCatFileBatch', () => {
      const oid = (c: string) => c.repeat(40);

      it('reads contents, missing entries and empty blobs in order', () => {
        const out = Buffer.from(`${oid('a')} blob 5\nhello\n:0:gone.txt missing\n${oid('b')} blob 0\n\n`, 'utf-8');
        assert.deepEqual(parseCatFileBatch(out, 3), ['hello', undefined, '']);
      });

      it('counts bytes, not characters, and keeps newlines inside content', () => {
        const content = 'é\nü\r\n';
        const size = Buffer.byteLength(content, 'utf-8');
        const out = Buffer.from(`${oid('c')} blob ${size}\n${content}\n`, 'utf-8');
        assert.deepEqual(parseCatFileBatch(out, 1), [content]);
      });

      it('throws on truncated output instead of returning wrong baselines', () => {
        assert.throws(() => parseCatFileBatch(Buffer.from(`${oid('d')} blob 50\nshort\n`, 'utf-8'), 1), /truncated/);
        assert.throws(() => parseCatFileBatch(Buffer.from(`${oid('d')} blob 1\nx\n`, 'utf-8'), 2), /ended after 1 of 2/);
      });
    });

    describe('getBaselines', () => {
      it('returns the same as getBaseline for every file, including missing and empty ones', async () => {
        await withRepo(async (g, root) => {
          const files: Record<string, string> = {
            'a.txt': 'alpha\n',
            'empty.txt': '',
            'dir with space/ü.txt': 'unicode é\n',
            'crlf.txt': 'one\r\ntwo\r\n',
          };
          for (const [rel, content] of Object.entries(files)) await g.snapshot(path.join(root, rel), content);
          const paths = [...Object.keys(files), 'never-tracked.txt'].map(rel => path.join(root, rel));

          const batch = await g.getBaselines(paths);
          assert.equal(batch.size, paths.length);
          for (const fp of paths) assert.equal(batch.get(fp), await g.getBaseline(fp), path.basename(fp));
          assert.equal(batch.get(path.join(root, 'empty.txt')), '');
          assert.equal(batch.get(path.join(root, 'never-tracked.txt')), undefined);
        });
      });

      it('handles an empty list', async () => {
        await withRepo(async g => {
          assert.equal((await g.getBaselines([])).size, 0);
        });
      });

      it('copes with a burst of single reads (the number of git processes is capped)', async () => {
        await withRepo(async (g, root) => {
          const fp = path.join(root, 'one.txt');
          await g.snapshot(fp, 'one\n');
          const results = await Promise.all(Array.from({ length: 150 }, () => g.getBaseline(fp)));
          assert.ok(results.every(r => r === 'one\n'));
        });
      });
    });

    describe('snapshotFiles', () => {
      it('stores the bytes on disk unchanged, whatever core.autocrlf says', async () => {
        await withRepo(async (g, root, hDir) => {
          execFileSync('git', ['config', 'core.autocrlf', 'true'], { env: { ...process.env, GIT_DIR: path.join(hDir, 'git') } });
          const fp = path.join(root, 'windows.txt');
          fs.writeFileSync(fp, 'a\r\nb\r\n');
          await g.snapshotFiles([fp]);
          assert.equal(await g.getBaseline(fp), 'a\r\nb\r\n');
        });
      });

      it('snapshots names with spaces and non-ASCII characters, and empty files', async () => {
        await withRepo(async (g, root) => {
          const a = path.join(root, 'my dir', 'naïve file.txt');
          const e = path.join(root, 'empty.txt');
          fs.mkdirSync(path.dirname(a), { recursive: true });
          fs.writeFileSync(a, 'héllo\n');
          fs.writeFileSync(e, '');
          await g.snapshotFiles([a, e]);
          assert.equal(await g.getBaseline(a), 'héllo\n');
          assert.equal(await g.getBaseline(e), '');
        });
      });

      it('skips a file that cannot be read and still snapshots the others', async () => {
        await withRepo(async (g, root) => {
          const x = path.join(root, 'x.txt');
          const y = path.join(root, 'y.txt');
          const gone = path.join(root, 'deleted-meanwhile.txt');
          fs.writeFileSync(x, 'x\n');
          fs.writeFileSync(y, 'y\n');
          await g.snapshotFiles([x, gone, y]);
          assert.equal(await g.getBaseline(x), 'x\n');
          assert.equal(await g.getBaseline(y), 'y\n');
          assert.equal(await g.getBaseline(gone), undefined);
        });
      });

      it('commits, so the files are listed as tracked', async () => {
        await withRepo(async (g, root) => {
          const fp = path.join(root, 'tracked.txt');
          fs.writeFileSync(fp, 't\n');
          await g.snapshotFiles([fp]);
          assert.ok((await g.listTrackedFiles()).some(p => p.endsWith('tracked.txt')));
        });
      });

      it('does nothing for an empty list', async () => {
        await withRepo(async g => {
          await g.snapshotFiles([]);
          assert.deepEqual(await g.listTrackedFiles(), []);
        });
      });

      it('handles more files than fit in one git process (several batches)', async () => {
        await withRepo(async (g, root) => {
          const count = 1250; // 3 batches
          const paths: string[] = [];
          for (let i = 0; i < count; i++) {
            const fp = path.join(root, `d${i % 25}`, `f${i}.txt`);
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            fs.writeFileSync(fp, `file ${i}\n`);
            paths.push(fp);
          }
          await g.snapshotFiles(paths);
          assert.equal((await g.listTrackedFiles()).length, count);

          const baselines = await g.getBaselines(paths);
          assert.equal(baselines.size, count);
          for (const i of [0, 1, 499, 500, 501, 999, 1000, 1249]) {
            assert.equal(baselines.get(paths[i]), `file ${i}\n`, `file ${i}`);
          }
          assert.ok([...baselines.values()].every(v => v !== undefined));
        });
      });
    });

    describe('progress callbacks', () => {
      const makeFiles = (root: string, count: number): string[] => {
        const paths: string[] = [];
        for (let i = 0; i < count; i++) {
          const fp = path.join(root, `p${i % 10}`, `f${i}.txt`);
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, `file ${i}\n`);
          paths.push(fp);
        }
        return paths;
      };

      it('snapshotFiles reports from 0 up to the total, once per batch', async () => {
        await withRepo(async (g, root) => {
          const paths = makeFiles(root, 1100); // 3 batches of up to 500
          const seen: [number, number][] = [];
          await g.snapshotFiles(paths, (done, total) => seen.push([done, total]));
          assert.deepEqual(seen, [[0, 1100], [500, 1100], [1000, 1100], [1100, 1100]]);
        });
      });

      it('scanAgainstDisk reports from 0 up to the number of files it hashes', async () => {
        await withRepo(async (g, root) => {
          const paths = makeFiles(root, 600);
          await g.snapshotFiles(paths);
          const seen: [number, number][] = [];
          await g.scanAgainstDisk(paths, (done, total) => seen.push([done, total]));
          assert.deepEqual(seen, [[0, 600], [500, 600], [600, 600]]);
        });
      });

      it('both work without a callback and with nothing to do', async () => {
        await withRepo(async g => {
          await g.snapshotFiles([]);
          assert.deepEqual((await g.scanAgainstDisk([])).unchanged, []);
        });
      });
    });

    describe('scanAgainstDisk', () => {
      const names = (root: string, list: string[]) => list.map(p => path.relative(root, p).replace(/\\/g, '/')).sort();

      it('sorts files into unchanged, differing, deleted and without baseline', async () => {
        await withRepo(async (g, root) => {
          const p = (n: string) => path.join(root, n);
          for (const n of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) fs.writeFileSync(p(n), `${n}\n`);
          await g.snapshotFiles(['a.txt', 'b.txt', 'c.txt', 'd.txt'].map(p));

          fs.writeFileSync(p('b.txt'), 'b changed\n');
          fs.rmSync(p('c.txt'));
          fs.writeFileSync(p('e.txt'), 'never snapshotted\n');

          const scan = await g.scanAgainstDisk(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map(p));
          assert.deepEqual(names(root, scan.unchanged), ['a.txt', 'd.txt']);
          assert.deepEqual(names(root, scan.differing), ['b.txt']);
          assert.deepEqual(names(root, scan.deleted), ['c.txt']);
          assert.deepEqual(names(root, scan.noBaseline), ['e.txt']);
          assert.deepEqual(scan.unreadable, []);
        });
      });

      it('sees a file stored with snapshot() (content through stdin) as unchanged', async () => {
        await withRepo(async (g, root) => {
          const fp = path.join(root, 'old-way.txt');
          fs.writeFileSync(fp, 'héllo\r\nwörld\n');
          await g.snapshot(fp, 'héllo\r\nwörld\n');
          assert.deepEqual((await g.scanAgainstDisk([fp])).unchanged, [fp]);
        });
      });

      it('compares raw bytes even when core.autocrlf is on', async () => {
        await withRepo(async (g, root, hDir) => {
          execFileSync('git', ['config', 'core.autocrlf', 'true'], { env: { ...process.env, GIT_DIR: path.join(hDir, 'git') } });
          const fp = path.join(root, 'crlf.txt');
          fs.writeFileSync(fp, 'a\r\nb\r\n');
          await g.snapshotFiles([fp]);
          assert.deepEqual((await g.scanAgainstDisk([fp])).unchanged, [fp]);
          fs.writeFileSync(fp, 'a\nb\n'); // only the line endings changed: still a difference
          assert.deepEqual((await g.scanAgainstDisk([fp])).differing, [fp]);
        });
      });

      it('treats something that is not a regular file as unreadable, not as a change', async () => {
        await withRepo(async (g, root) => {
          const fp = path.join(root, 'was-a-file');
          fs.writeFileSync(fp, 'x\n');
          await g.snapshotFiles([fp]);
          fs.rmSync(fp);
          fs.mkdirSync(fp); // a directory took its place
          const scan = await g.scanAgainstDisk([fp]);
          assert.deepEqual(scan.unreadable, [fp]);
          assert.deepEqual([...scan.differing, ...scan.deleted, ...scan.unchanged], []);
        });
      });

      it('finds exactly the changed files among more than one batch', async () => {
        await withRepo(async (g, root) => {
          const paths: string[] = [];
          for (let i = 0; i < 1100; i++) {
            const fp = path.join(root, `d${i % 20}`, `f${i}.txt`);
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            fs.writeFileSync(fp, `file ${i}\n`);
            paths.push(fp);
          }
          await g.snapshotFiles(paths);
          fs.writeFileSync(paths[3], 'edited\n');
          fs.writeFileSync(paths[600], 'edited\n');
          fs.rmSync(paths[1099]);

          const scan = await g.scanAgainstDisk(paths);
          assert.deepEqual(names(root, scan.differing), names(root, [paths[3], paths[600]]));
          assert.deepEqual(scan.deleted, [paths[1099]]);
          assert.equal(scan.unchanged.length, 1097);
          assert.equal(scan.noBaseline.length + scan.unreadable.length, 0);
        });
      });

      it('handles an empty list', async () => {
        await withRepo(async g => {
          const scan = await g.scanAgainstDisk([]);
          assert.deepEqual(scan, { unchanged: [], differing: [], deleted: [], noBaseline: [], unreadable: [] });
        });
      });
    });
  });

  describe('destroyGit', () => {
    it('removes the git directory', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-destroy-'));
      const hDir = path.join(dir2, '.vscode', 'hunktracker');
      const g2 = new HunktrackerGit(hDir, dir2);
      await g2.initGit();
      assert.ok(fs.existsSync(path.join(hDir, 'git')));
      g2.destroyGit();
      assert.ok(!fs.existsSync(path.join(hDir, 'git')));
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('preserves settings.json after destroy', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-destroy2-'));
      const hDir = path.join(dir2, '.vscode', 'hunktracker');
      const g2 = new HunktrackerGit(hDir, dir2);
      await g2.initGit();
      g2.saveSettings({ ignorePatterns: ['dist'], respectGitignore: false, clearOnBranchSwitch: false, useDiffEditor: false, showInlineDecorations: true });
      g2.destroyGit();
      assert.ok(fs.existsSync(path.join(hDir, 'settings.json')));
      fs.rmSync(dir2, { recursive: true, force: true });
    });
  });
});
