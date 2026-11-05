import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { normalizePath, toGitRelPath } from './pathNormalize';
import { mkdirRetry, removeDirSync } from './fsUtil';
import { mapLimit } from './concurrency';

const execFileAsync = promisify(execFile);

/**
 * Files per git process in the batched operations below. Large enough that a big repo needs a
 * handful of processes instead of one per file (starting a process costs tens of milliseconds
 * on Windows), small enough to keep stdin/stdout buffers modest.
 */
const BATCH_FILES = 500;
/** Most git processes started at once when a file has to be handled on its own. */
const SINGLE_FILE_CONCURRENCY = 4;
/** Most git commands running at once through HunktrackerGit.git(). */
const MAX_GIT_PROCESSES = 8;

/**
 * Run git with `stdin` as input and collect stdout as raw bytes. Rejects on a spawn error or a
 * non-zero exit, with git's stderr in the message. `env` and `cwd` come from the caller.
 */
function runGitWithInput(args: string[], stdin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`git ${args[0]} exited with ${code}: ${Buffer.concat(err).toString('utf-8').trim()}`));
    });
    // A git that dies early closes the pipe: the exit code above carries the real error
    child.stdin.on('error', () => { /* ignored */ });
    child.stdin.end(stdin, 'utf-8');
  });
}

/**
 * Parse the output of `git cat-file --batch`: for every requested name either
 * `<oid> <type> <size>\n<size bytes>\n` or `<name> missing\n`. Returns one entry per request in
 * order: the content, or undefined when the object does not exist.
 */
export function parseCatFileBatch(output: Buffer, count: number): (string | undefined)[] {
  const results: (string | undefined)[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const eol = output.indexOf(0x0a, pos);
    if (eol < 0) throw new Error(`cat-file output ended after ${i} of ${count} entries`);
    const header = output.toString('utf-8', pos, eol);
    pos = eol + 1;
    const m = /^[0-9a-f]{40,64} \w+ (\d+)$/.exec(header);
    if (!m) {
      results.push(undefined); // "<name> missing" or "<name> ambiguous"
      continue;
    }
    const size = Number(m[1]);
    if (pos + size > output.length) throw new Error(`cat-file output truncated in entry ${i} of ${count}`);
    results.push(output.toString('utf-8', pos, pos + size));
    pos += size + 1; // the content is followed by one LF
  }
  return results;
}

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

/** Result of HunktrackerGit.scanAgainstDisk: where each file stands against its baseline. */
export interface DiskScan {
  /** Disk bytes equal the baseline. */
  unchanged: string[];
  /** Baseline exists and the file exists with different bytes. */
  differing: string[];
  /** Baseline exists but the file is gone from disk. */
  deleted: string[];
  /** Not in the index. */
  noBaseline: string[];
  /** Exists but could not be read (permissions, not a regular file). */
  unreadable: string[];
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
      await this.acquireGitSlot();
      try {
        const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
          cwd: this.workTree,
          env: this.env,
          maxBuffer: 10 * 1024 * 1024, // 10 MB — default 1 MB is too small for large files
        });
        return stdout;
      } finally {
        this.releaseGitSlot();
      }
    };
    return retryOnLock ? this.withLockRetry(run) : run();
  }

  // At most MAX_GIT_PROCESSES git commands run at once through git(). Callers that fire many
  // commands together (a burst of file events, a checkout touching thousands of files) would
  // otherwise start that many processes simultaneously and stall the machine.
  private runningGit = 0;
  private gitWaiters: (() => void)[] = [];

  private async acquireGitSlot(): Promise<void> {
    if (this.runningGit < MAX_GIT_PROCESSES) {
      this.runningGit++;
      return;
    }
    // The slot is handed over by releaseGitSlot without the count dropping
    await new Promise<void>(resolve => this.gitWaiters.push(resolve));
  }

  private releaseGitSlot(): void {
    const next = this.gitWaiters.shift();
    if (next) next();
    else this.runningGit--;
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
      // One `git hash-object` per file, but never more than a few at once: starting them all
      // together (hundreds or thousands of processes) can bring a machine to a halt.
      const entries = await mapLimit(files, SINGLE_FILE_CONCURRENCY * 2, ({ filePath, content }) =>
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
      );
      await this.stageEntries(entries);
    } catch (err) {
      this.log(`snapshotBatch failed (${files.length} files): ${err}`);
    }
  }

  /** Stage `rel → blob hash` entries, chunked to avoid OS argument length limits, and commit once. */
  private async stageEntries(entries: { rel: string; hash: string }[]): Promise<void> {
    const CHUNK = 100;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const cacheArgs = entries.slice(i, i + CHUNK).flatMap(({ rel, hash }) => ['--add', '--cacheinfo', `100644,${hash},${rel}`]);
      await this.git(['update-index', ...cacheArgs]);
    }
    await this.commit();
  }

  /**
   * Snapshot files as they are on disk: git reads and hashes them itself, in batches of
   * BATCH_FILES per process, so a whole workspace needs a few processes instead of one per file
   * and no file content passes through Node. Bytes are stored unmodified (no line-ending or other
   * filters). Files that cannot be read (deleted meanwhile, permissions) are skipped.
   */
  async snapshotFiles(filePaths: string[], onProgress?: (done: number, total: number) => void): Promise<void> {
    if (filePaths.length === 0) return;
    await this.initGit();
    try {
      const entries: { rel: string; hash: string }[] = [];
      onProgress?.(0, filePaths.length);
      for (let i = 0; i < filePaths.length; i += BATCH_FILES) {
        const chunk = filePaths.slice(i, i + BATCH_FILES);
        const hashes = await this.hashFiles(chunk);
        chunk.forEach((fp, j) => {
          const hash = hashes[j];
          if (hash) entries.push({ rel: toGitRelPath(this.workTree, fp), hash });
        });
        onProgress?.(Math.min(i + chunk.length, filePaths.length), filePaths.length);
      }
      if (entries.length < filePaths.length) {
        this.log(`snapshotFiles: skipped ${filePaths.length - entries.length} unreadable file(s) of ${filePaths.length}`);
      }
      if (entries.length > 0) await this.stageEntries(entries);
    } catch (err) {
      this.log(`snapshotFiles failed (${filePaths.length} files): ${err}`);
    }
  }

  /**
   * Write the given files into the object database and return their blob hashes in the same order
   * (undefined for a file that could not be read). One git process for the whole chunk; if that
   * fails (one unreadable file aborts it) or a path has a newline in it, the files are hashed one
   * by one, a few at a time.
   */
  private async hashFiles(filePaths: string[], write = true): Promise<(string | undefined)[]> {
    const mode = write ? ['-w'] : [];
    if (!filePaths.some(fp => fp.includes('\n'))) {
      try {
        const out = await runGitWithInput(
          ['hash-object', ...mode, '--no-filters', '--stdin-paths'],
          filePaths.join('\n') + '\n',
          this.env,
          this.workTree
        );
        const lines = out.toString('utf-8').split('\n').filter(Boolean);
        if (lines.length === filePaths.length) return lines;
      } catch {
        // fall through to the per-file path below
      }
    }
    return mapLimit(filePaths, SINGLE_FILE_CONCURRENCY, async fp => {
      try {
        const { stdout } = await execFileAsync('git', ['hash-object', ...mode, '--no-filters', '--', fp], { env: this.env, cwd: this.workTree });
        return stdout.trim() || undefined;
      } catch {
        return undefined;
      }
    });
  }

  /** Blob hash of every file in the index, by git-style relative path. One git process. */
  private async indexOids(): Promise<Map<string, string>> {
    const out = await runGitWithInput(['-c', 'core.quotepath=false', 'ls-files', '-s', '-z'], '', this.env, this.workTree);
    const oids = new Map<string, string>();
    for (const entry of out.toString('utf-8').split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const m = /^\d+ ([0-9a-f]+) 0$/.exec(entry.slice(0, tab));
      if (m) oids.set(entry.slice(tab + 1), m[1]);
    }
    return oids;
  }

  /**
   * Compare files with their baselines without reading baseline text: the disk bytes of each file
   * are hashed by git (a few processes in total) and compared with the blob hash in the index,
   * the way `git status` does it. Only files in `differing` or `deleted` need their baseline
   * content fetched (getBaselines), so a big workspace in which little changed costs little.
   * `differing` means different bytes: callers that compare decoded text should still do so.
   */
  async scanAgainstDisk(filePaths: string[], onProgress?: (done: number, total: number) => void): Promise<DiskScan> {
    await this.initGit();
    const scan: DiskScan = { unchanged: [], differing: [], deleted: [], noBaseline: [], unreadable: [] };
    const oids = await this.indexOids();

    const tracked: { fp: string; oid: string }[] = [];
    for (const fp of filePaths) {
      const oid = oids.get(toGitRelPath(this.workTree, fp));
      if (oid === undefined) scan.noBaseline.push(fp);
      else tracked.push({ fp, oid });
    }

    // Which files exist (a deleted file is not "unreadable": it is a pending change)
    const exists = await mapLimit(tracked, 64, async ({ fp }) => {
      try {
        return (await fs.promises.stat(fp)).isFile() ? 'file' : 'other';
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'other';
      }
    });
    const present: { fp: string; oid: string }[] = [];
    tracked.forEach((t, i) => {
      if (exists[i] === 'gone') scan.deleted.push(t.fp);
      else if (exists[i] === 'file') present.push(t);
      else scan.unreadable.push(t.fp);
    });

    onProgress?.(0, present.length);
    for (let i = 0; i < present.length; i += BATCH_FILES) {
      const chunk = present.slice(i, i + BATCH_FILES);
      const hashes = await this.hashFiles(chunk.map(c => c.fp), false);
      chunk.forEach((c, j) => {
        const hash = hashes[j];
        if (hash === undefined) scan.unreadable.push(c.fp);
        else if (hash === c.oid) scan.unchanged.push(c.fp);
        else scan.differing.push(c.fp);
      });
      onProgress?.(Math.min(i + chunk.length, present.length), present.length);
    }
    return scan;
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
   * Baselines for many files at once, from the index, in a single `git cat-file --batch` process
   * per BATCH_FILES files (a `git show` per file means one process per file, which stalls a
   * machine on a big repo). Same result as getBaseline for each file: the content, or undefined
   * when it is not tracked or git fails.
   */
  async getBaselines(filePaths: string[]): Promise<Map<string, string | undefined>> {
    await this.initGit();
    const result = new Map<string, string | undefined>();
    // A newline cannot be sent through cat-file's line protocol: ask for those one by one
    const hasNewline = (fp: string) => toGitRelPath(this.workTree, fp).includes('\n');
    const single = filePaths.filter(hasNewline);
    const batched = filePaths.filter(fp => !hasNewline(fp));
    for (let i = 0; i < batched.length; i += BATCH_FILES) {
      const chunk = batched.slice(i, i + BATCH_FILES);
      // `:0:<path>` names the stage-0 index entry; the explicit stage avoids ambiguity for paths like "1:x"
      const specs = chunk.map(fp => `:0:${toGitRelPath(this.workTree, fp)}`);
      let contents: (string | undefined)[];
      try {
        const out = await runGitWithInput(['cat-file', '--batch'], specs.join('\n') + '\n', this.env, this.workTree);
        contents = parseCatFileBatch(out, chunk.length);
      } catch (err) {
        this.log(`getBaselines: batch of ${chunk.length} failed, reading one by one: ${err}`);
        contents = await mapLimit(chunk, SINGLE_FILE_CONCURRENCY, fp => this.getBaseline(fp));
      }
      chunk.forEach((fp, j) => result.set(fp, contents[j]));
    }
    const rest = await mapLimit(single, SINGLE_FILE_CONCURRENCY, fp => this.getBaseline(fp));
    single.forEach((fp, j) => result.set(fp, rest[j]));
    return result;
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
