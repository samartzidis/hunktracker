import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, execFileSync } from 'child_process';
import { removeDirSync } from '../../fsUtil';

/** Folder name of the throwaway test repo that .vscode-test.mjs creates in the system temp dir. */
const THROWAWAY_REPO_NAME = 'hunktracker-it-workspace';

/**
 * Throw unless `root` is the throwaway repo from .vscode-test.mjs. Call before anything that writes
 * into .git or switches branches, so those tests can never run against a real project repo.
 */
export function assertThrowawayRepo(root: string): void {
  const expected = path.join(fs.realpathSync.native(os.tmpdir()), THROWAWAY_REPO_NAME);
  if (path.relative(expected, root) !== '' || !fs.existsSync(path.join(root, '.git', 'HEAD'))) {
    throw new Error(`refusing to run: ${root} is not the throwaway test repo ${expected}`);
  }
}

/** Run a git command in the test repo itself (not the hunktracker baseline repo, so no GIT_DIR). */
export function repoGit(root: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return execFileSync('git', args, { cwd: root, env, encoding: 'utf-8' });
}

export function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) throw new Error('No workspace folder');
  return folders[0].uri.fsPath;
}

/** The extension's per-workspace data dir (context.storageUri): holds settings.json and git/. */
export function getDataDir(): string {
  const dir = getStateManager()?.dir;
  if (!dir) throw new Error('extension has no data dir (not activated, or no folder open)');
  return dir;
}

export function hunktrackerGitEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: path.join(getDataDir(), 'git'),
    GIT_WORK_TREE: root,
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function gitListTracked(root: string): string[] {
  try {
    const out = execSync('git -c core.quotepath=false ls-tree HEAD --name-only -r', {
      cwd: root,
      env: hunktrackerGitEnv(root),
      encoding: 'utf-8',
    });
    return out.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function gitGetBaseline(root: string, relPath: string): string | undefined {
  try {
    return execSync(`git show ":${relPath}"`, {
      cwd: root,
      env: hunktrackerGitEnv(root),
      encoding: 'utf-8',
    });
  } catch {
    return undefined;
  }
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForCondition(fn: () => boolean, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error('Condition not met within timeout');
}

export async function enableHunktracker(): Promise<void> {
  // Tests write their files just before enabling. On Windows the VS Code file watcher reports
  // those creations late; if they arrive after Enable starts they look like external creates
  // (files entered as "new" with no baseline). Let them land while still disabled.
  await sleep(500);
  await vscode.commands.executeCommand('hunktracker.enable');
  const gitDir = path.join(getDataDir(), 'git');
  await waitForCondition(() => fs.existsSync(gitDir));
  await sleep(200);
}

export async function disableHunktracker(): Promise<void> {
  const sm = getStateManager();
  if (sm?.enabled) {
    // Let queued git work finish first, so no git process is still running against the dir we delete.
    try { await sm.flush(); } catch { /* ignore */ }
  }
  await vscode.commands.executeCommand('hunktracker.disable');
  const gitDir = path.join(getDataDir(), 'git');
  try {
    await waitForCondition(() => !fs.existsSync(gitDir), 5000, 50);
  } catch (e) {
    let listing = '?';
    try { listing = JSON.stringify(fs.readdirSync(gitDir)); } catch (e2) { listing = String(e2); }
    throw new Error(`git dir still present after disable: ${listing}; sm.enabled=${getStateManager()?.enabled}`);
  }
}

export function writeFileExternally(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

export async function writeFileViaVSCode(filePath: string, content: string): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const uri = vscode.Uri.file(filePath);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
}

export async function renameFileViaVSCode(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(oldUri, newUri);
  const success = await vscode.workspace.applyEdit(edit);
  if (!success) throw new Error(`Failed to rename ${oldUri.fsPath} → ${newUri.fsPath}`);
}

export async function deleteFileViaVSCode(uri: vscode.Uri): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.deleteFile(uri);
  const success = await vscode.workspace.applyEdit(edit);
  if (!success) throw new Error(`Failed to delete ${uri.fsPath}`);
}

export async function cleanWorkspace(): Promise<void> {
  // Never delete the git dir under an enabled extension: its 1s poll would later reset
  // the state to disabled in the middle of the next test.
  if (getStateManager()?.enabled) {
    try { await disableHunktracker(); } catch { /* ignore */ }
  }
  // A clean editor left open on a file a later test rewrites externally gets auto-reloaded by VS Code,
  // which can make the buffer equal disk before the watcher looks and be mistaken for a user save.
  try { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); } catch { /* ignore */ }
  const root = getWorkspaceRoot();
  for (const entry of fs.readdirSync(root)) {
    // .git belongs to the throwaway test repo created by .vscode-test.mjs: keep it across tests
    if (entry === '.vscode' || entry === '.gitkeep' || entry === '.git') continue;
    removeDirSync(path.join(root, entry));
  }
  const hunktrackerDir = getStateManager()?.dir as string | undefined;
  if (hunktrackerDir && fs.existsSync(hunktrackerDir)) {
    removeDirSync(hunktrackerDir);
  }
  // settings.json is gone, so drop the in-memory settings the previous test left behind too.
  getStateManager()?.resetToDisabled();
}

export function getReviewPanel(): any {
  const ext = vscode.extensions.getExtension('GeorgeSamartzidis.hunktracker');
  if (!ext || !ext.isActive) return undefined;
  const api = ext.exports;
  if (api && typeof api.getReviewPanel === 'function') {
    return api.getReviewPanel();
  }
  return undefined;
}

export function getStateManager(): any {
  const ext = vscode.extensions.getExtension('GeorgeSamartzidis.hunktracker');
  if (!ext || !ext.isActive) return undefined;
  const api = ext.exports;
  if (api && typeof api.getStateManager === 'function') {
    return api.getStateManager();
  }
  return undefined;
}

export function getFileWatcher(): any {
  const ext = vscode.extensions.getExtension('GeorgeSamartzidis.hunktracker');
  if (!ext || !ext.isActive) return undefined;
  const api = ext.exports;
  if (api && typeof api.getFileWatcher === 'function') {
    return api.getFileWatcher();
  }
  return undefined;
}

/** Workspace-relative path with forward slashes, as git prints and expects it (path.relative gives backslashes on Windows). */
export function relPath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/');
}
