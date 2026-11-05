import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { normalizePath, toGitRelPath } from './pathNormalize';
import { mkdirRetry, removeDirSync } from './fsUtil';

const execFileAsync = promisify(execFile);

/** Delays before each retry of a git command that hit a lock (so up to 1 + 4 attempts). */
const LOCK_RETRY_DELAYS_MS = [100, 200, 400, 800];

/**
 * True when a git failure is lock contention, which is transient: another git process holds
 * `index.lock` / `HEAD.lock`, or two writers raced to create the first commit
 * ("cannot lock ref 'HEAD': reference already exists").
 */
export function isGitLockError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message}\n${(err as { stderr?: string }).stderr ?? ''}` : String(err);
  return /Unable to create '[^']*\.lock'|cannot lock ref/i.test(text);
}

interface Settings {
  ignorePatterns: string[];
  respectGitignore: boolean;
  clearOnBranchSwitch: boolean;
  useDiffEditor: boolean;
  showInlineDecorations: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  ignorePatterns: process.platform === 'darwin' ? ['.git', '.DS_Store'] : ['.git'],
  respectGitignore: true,
  clearOnBranchSwitch: false,
  useDiffEditor: false,
  showInlineDecorations: true,
};

/**
 * Manages all hunktracker persistent state via:
 *   <hunktrackerDir>/settings.json  — ignorePatterns and other per-project settings
 *   <hunktrackerDir>/git/           — private git repo storing baselines
 *
 * hunktrackerDir is the extension's per-workspace storage folder (outside the project).
 * The git repo uses the workspace root as its work tree but keeps all git
 * metadata inside the hunktracker directory, so it never touches the project's
 * own .git and works even when the project has no git at all.
 *
 *   GIT_DIR       = <hunktrackerDir>/git
 *   GIT_WORK_TREE = <workspaceRoot>
 *
 * Each tracked file has exactly one entry in the single HEAD commit.
 * Every mutation (snapshot / remove) rewrites that commit via --amend so
 * the repo always has at most one commit and stays compact.
 */
export class HunktrackerGit {
  private hunktrackerDir: string;
  private gitDir: string;
  private workTree: string;
  private gitInitialized = false;
  private destroyed = false;
  private initPromise: Promise<void> | undefined;
  private log: (message: string) => void;

  constructor(hunktrackerDir: string, workspaceRoot: string, logger?: (message: string) => void) {
    this.hunktrackerDir = hunktrackerDir;
    this.gitDir = path.join(hunktrackerDir, 'git');
    this.workTree = workspaceRoot;
    this.log = logger ?? ((msg: string) => console.warn(`[hunktracker] ${msg}`));
  }

  // ── env / low-level git ───────────────────────────────────────────────────

  private get env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.workTree,
      GIT_TERMINAL_PROMPT: '0',
    };
  }

  /**
   * Run a git command. A lock-contention failure is retried a few times, which is safe for
   * every command used here (update-index, ls-files, show, ... give the same result when
   * repeated). Pass `retryOnLock = false` for commands that need a larger retry unit: see commit().
   */
  private async git(args: string[], retryOnLock = true): Promise<string> {
    const run = async (): Promise<string> => {
      const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
        cwd: this.workTree,
        env: this.env,
        maxBuffer: 10 * 1024 * 1024, // 10 MB — default 1 MB is too small for large files
      });
      return stdout;
    };
    return retryOnLock ? this.withLockRetry(run) : run();
  }

  /** Run `op`, retrying with a short backoff while it fails on git lock contention. */
  private async withLockRetry<T>(op: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await op();
      } catch (err) {
        if (attempt >= LOCK_RETRY_DELAYS_MS.length || this.destroyed || !isGitLockError(err)) throw err;
        const firstLine = String(err instanceof Error ? err.message : err).split('\n').find(l => /lock/i.test(l)) ?? '';
        this.log(`git lock contention, retry ${attempt + 1}/${LOCK_RETRY_DELAYS_MS.length}: ${firstLine.trim()}`);
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  // ── settings.json ─────────────────────────────────────────────────────────

  private get settingsPath(): string {
    return path.join(this.hunktrackerDir, 'settings.json');
  }

  loadSettings(): Settings {
    try {
      const raw = fs.readFileSync(this.settingsPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return {
        ignorePatterns: parsed.ignorePatterns ?? [...DEFAULT_SETTINGS.ignorePatterns],
        respectGitignore: parsed.respectGitignore ?? DEFAULT_SETTINGS.respectGitignore,
        clearOnBranchSwitch: parsed.clearOnBranchSwitch ?? DEFAULT_SETTINGS.clearOnBranchSwitch,
        useDiffEditor: typeof parsed.useDiffEditor === 'boolean'
          ? parsed.useDiffEditor
          : DEFAULT_SETTINGS.useDiffEditor,
        showInlineDecorations: typeof parsed.showInlineDecorations === 'boolean'
          ? parsed.showInlineDecorations
          : DEFAULT_SETTINGS.showInlineDecorations,
      };
    } catch {
      return { ...DEFAULT_SETTINGS, ignorePatterns: [...DEFAULT_SETTINGS.ignorePatterns] };
    }
  }

  saveSettings(settings: Settings): void {
    try {
      fs.mkdirSync(this.hunktrackerDir, { recursive: true });
      fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    } catch (err) {
      this.log(`saveSettings failed: ${err}`);
    }
  }

  /**
   * Merge defaults into existing settings.json.
   * Fields already present are kept; missing fields are added.
   * Returns the resulting settings.
   */
  mergeDefaultSettings(defaults: Settings): Settings {
    const existing = fs.existsSync(this.settingsPath) ? this.loadSettings() : ({} as Partial<Settings>);
    const merged: Settings = { ...defaults, ...existing };
    this.saveSettings(merged);
    return merged;
  }

  // ── git init ──────────────────────────────────────────────────────────────

  async initGit(): Promise<void> {
    if (this.destroyed || this.gitInitialized) return;
    // Serialize concurrent calls — only one init runs at a time
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitGit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = undefined;
    }
  }

  private async doInitGit(): Promise<void> {
    // Check for a valid git repo: HEAD file must exist. If the directory
    // exists but HEAD is missing, the repo is corrupted (e.g. interrupted
    // init). Re-initialize from scratch in that case.
    const headPath = path.join(this.gitDir, 'HEAD');
    if (!fs.existsSync(this.gitDir) || !fs.existsSync(headPath)) {
      if (fs.existsSync(this.gitDir)) {
        this.log('initGit: corrupted git dir detected (HEAD missing), re-initializing');
        try {
          removeDirSync(this.gitDir);
        } catch (err) {
          this.log(`initGit: failed to remove corrupted git dir: ${err}`);
          throw err;
        }
      }
      if (this.destroyed) return;
      await mkdirRetry(this.gitDir);
      await this.git(['init']);
      if (this.destroyed) return;
      await this.git(['config', 'user.email', 'hunktracker@localhost']);
      if (this.destroyed) return;
      await this.git(['config', 'user.name', 'hunktracker']);
    }
    if (this.destroyed) return;
    this.gitInitialized = true;
  }

  private async hasHead(): Promise<boolean> {
    try {
      await this.git(['rev-parse', 'HEAD']);
      return true;
    } catch {
      // Expected when repo has no commits yet
      return false;
    }
  }

  // ── snapshot / remove ─────────────────────────────────────────────────────

  /**
   * Write content into the git index for filePath (no commit).
   * Use commit() to persist.
   */
  async snapshot(filePath: string, content: string): Promise<void> {
    await this.initGit();
    const rel = toGitRelPath(this.workTree, filePath);
    try {
      const hash = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          'git',
          ['hash-object', '-w', '--stdin'],
          { env: this.env },
          (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
        );
        child.stdin!.end(content, 'utf-8');
      });
      await this.git(['update-index', '--add', '--cacheinfo', `100644,${hash},${rel}`]);
      await this.commit();
    } catch (err) {
      this.log(`snapshot failed for ${rel}: ${err}`);
      throw err;
    }
  }

  /**
   * Rename a file (or all files under a directory) in the git index and commit.
   * Reuses existing blob hashes — no content re-hashing needed.
   */
  async renameFile(oldFilePath: string, newFilePath: string): Promise<void> {
    await this.initGit();
    const oldRel = toGitRelPath(this.workTree, oldFilePath);
    const newRel = toGitRelPath(this.workTree, newFilePath);
    try {
      // ls-files returns all entries matching the path (a single file or all files under a directory)
      const lsOut = await this.git(['ls-files', '--stage', '--', oldRel]);
      const lines = lsOut.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return; // not tracked — nothing to rename

      // Parse all matching entries
      const entries: { mode: string; hash: string; entryRel: string }[] = [];
      for (const line of lines) {
        const m = line.match(/^(\d+) ([0-9a-f]+) \d+\t(.+)$/);
        if (!m) continue;
        entries.push({ mode: m[1], hash: m[2], entryRel: normalizePath(m[3]) });
      }
      if (entries.length === 0) return;

      // Remove all old entries
      const oldPaths = entries.map(e => e.entryRel);
      const CHUNK = 200;
      for (let i = 0; i < oldPaths.length; i += CHUNK) {
        await this.git(['update-index', '--force-remove', '--', ...oldPaths.slice(i, i + CHUNK)]);
      }

      // Add entries with new paths — replace oldRel prefix with newRel
      for (let i = 0; i < entries.length; i += CHUNK) {
        const cacheArgs = entries.slice(i, i + CHUNK).flatMap(({ mode, hash, entryRel }) => {
          const suffix = entryRel === oldRel ? '' : entryRel.slice(oldRel.length);
          const renamed = newRel + suffix;
          return ['--add', '--cacheinfo', `${mode},${hash},${renamed}`];
        });
        await this.git(['update-index', ...cacheArgs]);
      }
      await this.commit();
    } catch (err) {
      this.log(`renameFile failed (${path.relative(this.workTree, oldFilePath)} → ${path.relative(this.workTree, newFilePath)}): ${err}`);
      throw err;
    }
  }

  /**
   * Remove a file's baseline from the git index and commit.
   */
  async removeFile(filePath: string): Promise<void> {
    await this.initGit();
    const rel = toGitRelPath(this.workTree, filePath);
    try {
      const lsOut = await this.git(['ls-files', '--stage', '--', rel]);
      if (!lsOut.trim()) return; // not tracked — nothing to remove
      await this.git(['update-index', '--force-remove', '--', rel]);
      await this.commit();
    } catch (err) {
      this.log(`removeFile failed for ${rel}: ${err}`);
      throw err;
    }
  }

  /**
   * Snapshot multiple files at once — writes all blobs to index then commits once.
   * Much faster than calling snapshot() per file.
   */
  async snapshotBatch(files: { filePath: string; content: string }[]): Promise<void> {
    if (files.length === 0) return;
    await this.initGit();
    try {
      // Hash all blobs in parallel, then stage all at once and commit once
      const entries = await Promise.all(
        files.map(({ filePath, content }) =>
          new Promise<{ rel: string; hash: string }>((resolve, reject) => {
            const rel = toGitRelPath(this.workTree, filePath);
            const child = execFile(
              'git',
              ['hash-object', '-w', '--stdin'],
              { env: this.env },
              (err, stdout) => (err ? reject(err) : resolve({ rel, hash: stdout.trim() }))
            );
            child.stdin!.end(content, 'utf-8');
          })
        )
      );
      // Stage all entries, chunked to avoid OS argument length limits
      const CHUNK = 100;
      for (let i = 0; i < entries.length; i += CHUNK) {
        const cacheArgs = entries.slice(i, i + CHUNK).flatMap(({ rel, hash }) => ['--add', '--cacheinfo', `100644,${hash},${rel}`]);
        await this.git(['update-index', ...cacheArgs]);
      }
      await this.commit();
    } catch (err) {
      this.log(`snapshotBatch failed (${files.length} files): ${err}`);
    }
  }

  /**
   * Remove multiple files from the git index in a single operation and commit once.
   * Much faster than calling removeFile() per file.
   */
  async removeFileBatch(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;
    await this.initGit();
    try {
      const rels = filePaths.map(fp => toGitRelPath(this.workTree, fp));
      // Chunk to avoid exceeding OS argument length limits (~250KB on macOS)
      const CHUNK = 200;
      for (let i = 0; i < rels.length; i += CHUNK) {
        await this.git(['update-index', '--force-remove', '--', ...rels.slice(i, i + CHUNK)]);
      }
      await this.commit();
    } catch (err) {
      this.log(`removeFileBatch failed (${filePaths.length} files): ${err}`);
    }
  }

  private async commit(): Promise<void> {
    // The retry unit is the whole "is there a HEAD? then amend or create" decision, not the single
    // command: if two writers both saw no HEAD, the loser's initial commit fails with "cannot lock
    // ref 'HEAD': reference already exists", and only re-checking HEAD turns its retry into an amend.
    await this.withLockRetry(async () => {
      if (await this.hasHead()) {
        await this.git(['commit', '--amend', '--no-edit', '--allow-empty'], false);
      } else {
        await this.git(['commit', '-m', 'hunktracker baselines'], false);
      }
    });
  }

  /**
   * Return the baseline content for a file from the git index, or undefined if not tracked.
   * Reads from index (not HEAD) so newly staged files are immediately visible.
   */
  async getBaseline(filePath: string): Promise<string | undefined> {
    await this.initGit();
    const rel = toGitRelPath(this.workTree, filePath);
    try {
      return await this.git(['show', `:${rel}`]);
    } catch {
      return undefined;
    }
  }

  /**
   * Return absolute paths of all files currently tracked in HEAD.
   */
  async listTrackedFiles(): Promise<string[]> {
    await this.initGit();
    try {
      const out = await this.git(['ls-tree', 'HEAD', '--name-only', '-r']);
      return out
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(rel => normalizePath(path.join(this.workTree, rel)));
    } catch {
      return [];
    }
  }

  // ── destroy ───────────────────────────────────────────────────────────────

  /** Remove only the git directory (called on disable). settings.json is preserved. */
  destroyGit(): void {
    this.gitInitialized = false;
    this.destroyed = true;
    if (fs.existsSync(this.gitDir)) {
      try {
        removeDirSync(this.gitDir);
      } catch (err) {
        this.log(`destroyGit failed: ${err}`);
      }
    }
  }
}
