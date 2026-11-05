import { defineConfig } from '@vscode/test-cli';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The integration tests run against a throwaway git repo OUTSIDE this project, recreated on every
// run. It has a real `.git` so the branch-switch test can run real `git switch`, and being outside
// the project means no test can ever touch this repo's own .git. The tests check for this name
// before they write to .git/HEAD (see branchSwitch.test.ts).
const WORKSPACE_DIR_NAME = 'hunktracker-it-workspace';

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // git writes object files read-only, which fails the delete on Windows: clear the flags, retry
    try {
      for (const entry of fs.readdirSync(dir, { recursive: true })) {
        try { fs.chmodSync(path.join(dir, entry), 0o666); } catch { /* best effort */ }
      }
    } catch { /* directory unreadable: the retry below reports the real problem */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

function createWorkspace() {
  const dir = path.join(os.tmpdir(), WORKSPACE_DIR_NAME);
  removeDir(dir);
  fs.mkdirSync(dir, { recursive: true });
  // Without GIT_* so a git started from a hook or another repo's environment cannot redirect these
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'hunktracker-test@localhost');
  git('config', 'user.name', 'hunktracker test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('commit', '-q', '--allow-empty', '-m', 'initial');
  // The real path: os.tmpdir() can be a Windows 8.3 short path, which would not match the paths
  // VS Code reports back to the tests.
  return fs.realpathSync.native(dir);
}

export default defineConfig({
  files: 'out-integration/test/integration/**/*.test.js',
  installPath: '/Applications/Visual Studio Code - Insiders.app',
  workspaceFolder: createWorkspace(),
  launchArgs: [
    '--enable-proposed-api=GeorgeSamartzidis.hunktracker',
    '--disable-extensions',
    '--disable-gpu',
  ],
  mocha: {
    timeout: 30000,
  },
});
