import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as git from 'isomorphic-git';
import { GitIndexManager } from 'isomorphic-git/managers';
import { FileSystem } from 'isomorphic-git/models';
import { normalizePath, toGitRelPath } from './pathNormalize';
import { mkdirRetry, removeDirSync } from './fsUtil';
import { mapLimit } from './concurrency';
import { withoutBuiltInPatterns } from './ignorePatterns';
import { isOverSizeLimit, MAX_TRACKED_FILE_BYTES } from './fileLimits';

/** Files read, hashed and stored at the same time while taking baselines: bounds memory to a few files. */
const SNAPSHOT_CONCURRENCY = 8;
/** Files stat'ed at once. */
const STAT_CONCURRENCY = 64;
/** Files streamed through the hash at once when comparing the disk with the baselines. */
const HASH_CONCURRENCY = 32;
/** Baseline blobs read from the object store at once. */
const BLOB_READ_CONCURRENCY = 8;
/** Git file mode of a plain, non-executable file. */
const FILE_MODE = 0o100644;
/**
 * A file whose size and modified time match what the index recorded is taken as unchanged without
 * reading it, as git does. Not when it was modified shortly before the index was written: a change made
 * within the same timestamp tick would keep the recorded time ("racily clean" in git). 2 s covers file
 * systems with coarse timestamps (FAT).
 */
const RACY_WINDOW_MS = 2000;
const UINT32 = 2 ** 32;

/** Seconds and nanoseconds of a modified time the way isomorphic-git stores them in the index. */
function indexTime(mtimeMs: number): [number, number] {
  const seconds = Math.floor(mtimeMs / 1000);
  const nanoseconds = Math.floor((mtimeMs - seconds * 1000) * 1000000);
  return [seconds % UINT32, nanoseconds % UINT32];
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
  /** Has a baseline, but the file has grown over the size limit: it is no longer tracked. */
  tooLarge: string[];
  /** How many files had to be read and hashed (the rest were settled by size and modified time). */
  hashed: number;
}

interface Settings {
  ignorePatterns: string[];
  respectGitignore: boolean;
  clearOnBranchSwitch: boolean;
  useDiffEditor: boolean;
  showInlineDecorations: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  ignorePatterns: [],
  respectGitignore: true,
  clearOnBranchSwitch: false,
  useDiffEditor: false,
  showInlineDecorations: true,
};

/** Index stats for a baseline that does not come from a file on disk: only the mode is meaningful. */
function plainFileStats() {
  return { ctimeSeconds: 0, ctimeNanoseconds: 0, mtimeSeconds: 0, mtimeNanoseconds: 0, dev: 0, ino: 0, mode: FILE_MODE, uid: 0, gid: 0, size: 0 };
}

/** The git blob id of `size` bytes streamed from `filePath`, or undefined if the file cannot be read in full. */
function hashFileAsBlob(filePath: string, size: number): Promise<string | undefined> {
  return new Promise(resolve => {
    const hash = crypto.createHash('sha1');
    hash.update(`blob ${size}\0`);
    let read = 0;
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => {
      read += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', () => resolve(undefined));
    // A file that grew or shrank while it was read cannot be compared reliably
    stream.on('end', () => resolve(read === size ? hash.digest('hex') : undefined));
  });
}

/**
 * Manages all hunktracker persistent state via:
 *   <hunktrackerDir>/settings.json  — ignorePatterns and other per-project settings
 *   <hunktrackerDir>/git/           — private git repository storing baselines
 *
 * hunktrackerDir is the extension's per-workspace storage folder (outside the project). The repository
 * keeps all its metadata there and uses the workspace root only to resolve paths, so it never touches
 * the project's own .git and works even when the project has no git at all.
 *
 * Baselines are the git INDEX of that repository: one entry per tracked file, pointing at a blob in the
 * object store. There are no commits. Everything is done in-process with isomorphic-git: no git
 * executable is needed and no process is ever started. Several files are changed with one index write.
 */
export class HunktrackerGit {
  private hunktrackerDir: string;
  private gitDir: string;
  private workTree: string;
  private gitInitialized = false;
  private destroyed = false;
  private initPromise: Promise<void> | undefined;
  private log: (message: string) => void;
  /** isomorphic-git keeps the parsed index here, so it is read from disk only when the file changed. */
  private cache: object = {};
  private readonly nodeFs = new FileSystem(fs);

  constructor(hunktrackerDir: string, workspaceRoot: string, logger?: (message: string) => void) {
    this.hunktrackerDir = hunktrackerDir;
    this.gitDir = path.join(hunktrackerDir, 'git');
    this.workTree = workspaceRoot;
    this.log = logger ?? ((msg: string) => console.warn(`[hunktracker] ${msg}`));
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
        ignorePatterns: withoutBuiltInPatterns(parsed.ignorePatterns ?? DEFAULT_SETTINGS.ignorePatterns),
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

  // ── repository ────────────────────────────────────────────────────────────

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
    // A valid repository has a HEAD file. If the directory exists without one, it is corrupted
    // (e.g. an interrupted init): start again from scratch.
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
      await git.init({ fs, dir: this.workTree, gitdir: this.gitDir, defaultBranch: 'main' });
    }
    if (this.destroyed) return;
    // Bytes must be stored exactly as they are on disk: never convert line endings
    await git.setConfig({ fs, dir: this.workTree, gitdir: this.gitDir, path: 'core.autocrlf', value: 'false' });
    if (this.destroyed) return;
    this.gitInitialized = true;
  }

  /**
   * Whether baselines may be written. Not once the store was destroyed (Disable), and not when its
   * folder has gone (deleted from outside): isomorphic-git creates missing folders when it writes,
   * so a late write would leave a half repository behind, which looks like an enabled project.
   */
  private canWrite(what: string): boolean {
    if (!this.destroyed && fs.existsSync(path.join(this.gitDir, 'HEAD'))) return true;
    this.log(`${what}: baseline store is gone, not writing`);
    return false;
  }

  /**
   * If the index cannot be read (damaged, e.g. by a crash in the middle of writing it), move it
   * aside as `index.damaged` so the store starts again with no baselines. Returns true when that
   * happened: the caller should take fresh baselines, otherwise every file would look new.
   */
  async repairIfDamaged(): Promise<boolean> {
    await this.initGit();
    if (!this.canWrite('repairIfDamaged')) return false;
    let readable = false;
    try {
      await this.withIndex(() => { readable = true; });
      return false;
    } catch (err) {
      if (readable) throw err; // the index was read; something else failed
      this.log(`baseline index is damaged (${err}), starting again with fresh baselines`);
      const indexPath = path.join(this.gitDir, 'index');
      try {
        fs.rmSync(indexPath + '.damaged', { force: true });
        fs.renameSync(indexPath, indexPath + '.damaged');
      } catch (moveErr) {
        this.log(`could not move the damaged index aside, deleting it: ${moveErr}`);
        fs.rmSync(indexPath, { force: true });
      }
      this.cache = {};
      return true;
    }
  }

  /** Run `fn` with exclusive access to the index; the index is written back once if `fn` changed it. */
  private withIndex<T>(fn: (index: IndexLike) => T | Promise<T>): Promise<T> {
    return GitIndexManager.acquire(
      { fs: this.nodeFs, gitdir: this.gitDir, cache: this.cache },
      fn as (index: unknown) => T | Promise<T>
    ) as Promise<T>;
  }

  private async writeBlob(content: Uint8Array): Promise<string> {
    return git.writeBlob({ fs, dir: this.workTree, gitdir: this.gitDir, blob: content });
  }

  // ── snapshot / remove ─────────────────────────────────────────────────────

  /** Store `content` as the baseline of `filePath`. */
  async snapshot(filePath: string, content: string): Promise<void> {
    await this.initGit();
    if (!this.canWrite('snapshot')) return;
    const rel = toGitRelPath(this.workTree, filePath);
    try {
      const oid = await this.writeBlob(Buffer.from(content, 'utf-8'));
      await this.withIndex(index => {
        index.insert({ filepath: rel, oid, stats: plainFileStats() });
      });
    } catch (err) {
      this.log(`snapshot failed for ${rel}: ${err}`);
      throw err;
    }
  }

  /**
   * Rename a file (or all files under a directory) in the index. The baselines keep their blobs:
   * no content is read or written.
   */
  async renameFile(oldFilePath: string, newFilePath: string): Promise<void> {
    await this.initGit();
    if (!this.canWrite('renameFile')) return;
    const oldRel = toGitRelPath(this.workTree, oldFilePath);
    const newRel = toGitRelPath(this.workTree, newFilePath);
    try {
      await this.withIndex(index => {
        const moved: { rel: string; entry: IndexEntry }[] = [];
        for (const [entryRel, entry] of index.entriesMap) {
          if (entryRel === oldRel || entryRel.startsWith(oldRel + '/')) moved.push({ rel: normalizePath(entryRel), entry });
        }
        if (moved.length === 0) return; // not tracked — nothing to rename
        for (const { rel } of moved) index.delete({ filepath: rel });
        for (const { rel, entry } of moved) {
          const suffix = rel === oldRel ? '' : rel.slice(oldRel.length);
          index.insert({ filepath: newRel + suffix, oid: entry.oid, stats: entry });
        }
      });
    } catch (err) {
      this.log(`renameFile failed (${path.relative(this.workTree, oldFilePath)} → ${path.relative(this.workTree, newFilePath)}): ${err}`);
      throw err;
    }
  }

  /** Remove a file's baseline. */
  async removeFile(filePath: string): Promise<void> {
    await this.initGit();
    if (!this.canWrite('removeFile')) return;
    const rel = toGitRelPath(this.workTree, filePath);
    try {
      await this.withIndex(index => {
        if (index.has({ filepath: rel })) index.delete({ filepath: rel });
      });
    } catch (err) {
      this.log(`removeFile failed for ${rel}: ${err}`);
      throw err;
    }
  }

  /** Remove many baselines with a single index write. */
  async removeFileBatch(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;
    await this.initGit();
    if (!this.canWrite('removeFileBatch')) return;
    try {
      const rels = filePaths.map(fp => toGitRelPath(this.workTree, fp));
      await this.withIndex(index => {
        for (const rel of rels) {
          if (index.has({ filepath: rel })) index.delete({ filepath: rel });
        }
      });
    } catch (err) {
      this.log(`removeFileBatch failed (${filePaths.length} files): ${err}`);
    }
  }

  /**
   * Take baselines of files as they are on disk. The bytes are stored unmodified (no line-ending or
   * other conversion). Files that cannot be read (deleted meanwhile, permissions) and files over the
   * size limit (see fileLimits.ts) are skipped. Files are read and stored a few at a time, so memory
   * stays small however big the workspace is, and all of them are recorded with one index write
   * (every index write rewrites the whole file). `onProgress` is called after each file.
   */
  async snapshotFiles(filePaths: string[], onProgress?: (done: number, total: number) => void): Promise<void> {
    if (filePaths.length === 0) return;
    await this.initGit();
    if (!this.canWrite('snapshotFiles')) return;
    let unreadable = 0;
    let tooLarge = 0;
    try {
      let done = 0;
      onProgress?.(0, filePaths.length);
      const stored = await mapLimit(filePaths, SNAPSHOT_CONCURRENCY, async fp => {
        try {
          const stats = await fs.promises.stat(fp);
          if (!stats.isFile()) return undefined;
          if (isOverSizeLimit(stats.size)) {
            tooLarge++;
            return undefined;
          }
          const oid = await this.writeBlob(await fs.promises.readFile(fp));
          return { rel: toGitRelPath(this.workTree, fp), oid, stats };
        } catch {
          unreadable++;
          return undefined;
        } finally {
          onProgress?.(++done, filePaths.length);
        }
      });
      const entries = stored.filter((e): e is NonNullable<typeof e> => e !== undefined);
      if (entries.length > 0) {
        await this.withIndex(index => {
          for (const { rel, oid, stats } of entries) index.insert({ filepath: rel, oid, stats });
        });
      }
      if (unreadable > 0) this.log(`snapshotFiles: skipped ${unreadable} unreadable file(s) of ${filePaths.length}`);
      if (tooLarge > 0) this.log(`snapshotFiles: skipped ${tooLarge} file(s) over the size limit of ${MAX_TRACKED_FILE_BYTES / (1024 * 1024)} MB`);
    } catch (err) {
      this.log(`snapshotFiles failed (${filePaths.length} files): ${err}`);
    }
  }

  /** The index entry (blob id, recorded size and modified time) of each given path that has a baseline. */
  private async lookupEntries(rels: string[]): Promise<Map<string, IndexEntry>> {
    return this.withIndex(index => {
      const entries = new Map<string, IndexEntry>();
      for (const rel of rels) {
        const entry = index.entriesMap.get(rel);
        if (entry) entries.set(rel, entry);
      }
      return entries;
    });
  }

  /** The blob id of each given path that has a baseline, by git-style relative path. */
  private async lookupOids(rels: string[]): Promise<Map<string, string>> {
    const oids = new Map<string, string>();
    for (const [rel, entry] of await this.lookupEntries(rels)) oids.set(rel, entry.oid);
    return oids;
  }

  /**
   * Compare files with their baselines without reading baseline text. A file whose size and modified
   * time match the ones recorded in the index is unchanged (as in git; see RACY_WINDOW_MS); any other
   * file is streamed through a hash (a few at a time, in small pieces) and compared with the blob id.
   * Files found unchanged that way get their size and time recorded, so the next scan can skip them.
   * Only files in `differing` or `deleted` need their baseline content fetched, so a big workspace in
   * which little changed costs little. `differing` means different bytes: callers that compare
   * decoded text should still do so.
   */
  async scanAgainstDisk(filePaths: string[], onProgress?: (done: number, total: number) => void): Promise<DiskScan> {
    await this.initGit();
    const scan: DiskScan = { unchanged: [], differing: [], deleted: [], noBaseline: [], unreadable: [], tooLarge: [], hashed: 0 };
    const rels = filePaths.map(fp => toGitRelPath(this.workTree, fp));
    const entries = await this.lookupEntries(rels);
    let indexWrittenMs = 0;
    try {
      indexWrittenMs = (await fs.promises.stat(path.join(this.gitDir, 'index'))).mtimeMs;
    } catch {
      // no index: nothing is tracked, so nothing is trusted either
    }

    const tracked: { fp: string; rel: string; entry: IndexEntry }[] = [];
    filePaths.forEach((fp, i) => {
      const entry = entries.get(rels[i]);
      if (entry === undefined) scan.noBaseline.push(fp);
      else tracked.push({ fp, rel: rels[i], entry });
    });

    // Which files exist (a deleted file is not "unreadable": it is a pending change), and which of
    // them still have the size and modified time recorded with their baseline
    const toHash: { fp: string; rel: string; oid: string; stats: fs.Stats }[] = [];
    const found = await mapLimit(tracked, STAT_CONCURRENCY, async ({ fp }) => {
      try {
        const stats = await fs.promises.stat(fp);
        return stats.isFile() ? stats : 'other';
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'other';
      }
    });
    tracked.forEach((t, i) => {
      const f = found[i];
      if (f === 'gone') scan.deleted.push(t.fp);
      else if (f === 'other') scan.unreadable.push(t.fp);
      else if (isOverSizeLimit(f.size)) scan.tooLarge.push(t.fp);
      else if (statMatches(t.entry, f) && f.mtimeMs < indexWrittenMs - RACY_WINDOW_MS) scan.unchanged.push(t.fp);
      else toHash.push({ fp: t.fp, rel: t.rel, oid: t.entry.oid, stats: f });
    });

    let hashed = 0;
    onProgress?.(0, toHash.length);
    const hashes = await mapLimit(toHash, HASH_CONCURRENCY, async c => {
      try {
        return await hashFileAsBlob(c.fp, c.stats.size);
      } finally {
        onProgress?.(++hashed, toHash.length);
      }
    });
    scan.hashed = toHash.length;
    const refresh: { rel: string; oid: string; stats: fs.Stats }[] = [];
    toHash.forEach((c, j) => {
      const hash = hashes[j];
      if (hash === undefined) scan.unreadable.push(c.fp);
      else if (hash === c.oid) {
        scan.unchanged.push(c.fp);
        refresh.push(c);
      } else scan.differing.push(c.fp);
    });
    if (refresh.length > 0) await this.recordStats(refresh);
    return scan;
  }

  /**
   * Record the size and modified time of files that were just found to equal their baseline, so the
   * next scan can trust them without reading them. An entry whose baseline changed meanwhile is left
   * alone. Best effort: a failure only means those files are read again next time.
   */
  private async recordStats(files: { rel: string; oid: string; stats: fs.Stats }[]): Promise<void> {
    if (this.destroyed || !fs.existsSync(path.join(this.gitDir, 'HEAD'))) return;
    try {
      await this.withIndex(index => {
        for (const { rel, oid, stats } of files) {
          if (index.entriesMap.get(rel)?.oid === oid) index.insert({ filepath: rel, oid, stats });
        }
      });
    } catch (err) {
      this.log(`recording file times failed (${files.length} files): ${err}`);
    }
  }

  /**
   * Return the baseline content for a file, or undefined if not tracked.
   */
  async getBaseline(filePath: string): Promise<string | undefined> {
    return (await this.getBaselines([filePath])).get(filePath);
  }

  /**
   * Baselines for many files at once: the content, or undefined when a file is not tracked or its
   * blob cannot be read. Blobs are read a few at a time.
   */
  async getBaselines(filePaths: string[]): Promise<Map<string, string | undefined>> {
    await this.initGit();
    const result = new Map<string, string | undefined>();
    try {
      const rels = filePaths.map(fp => toGitRelPath(this.workTree, fp));
      const oids = await this.lookupOids(rels);
      const contents = await mapLimit(filePaths, BLOB_READ_CONCURRENCY, async (fp, i) => {
        const oid = oids.get(rels[i]);
        if (oid === undefined) return undefined;
        try {
          const { blob } = await git.readBlob({ fs, dir: this.workTree, gitdir: this.gitDir, oid });
          return Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength).toString('utf-8');
        } catch {
          return undefined;
        }
      });
      filePaths.forEach((fp, i) => result.set(fp, contents[i]));
    } catch (err) {
      this.log(`getBaselines failed (${filePaths.length} files): ${err}`);
      for (const fp of filePaths) result.set(fp, undefined);
    }
    return result;
  }

  /**
   * Return absolute paths of all files that have a baseline.
   */
  async listTrackedFiles(): Promise<string[]> {
    await this.initGit();
    try {
      const rels = await this.withIndex(index => [...index.entriesMap.keys()]);
      return rels.map(rel => normalizePath(path.join(this.workTree, rel)));
    } catch (err) {
      this.log(`listTrackedFiles failed: ${err}`);
      return [];
    }
  }

  // ── destroy ───────────────────────────────────────────────────────────────

  /** Remove only the git directory (called on disable). settings.json is preserved. */
  destroyGit(): void {
    this.gitInitialized = false;
    this.destroyed = true;
    this.cache = {};
    if (fs.existsSync(this.gitDir)) {
      try {
        removeDirSync(this.gitDir);
      } catch (err) {
        this.log(`destroyGit failed: ${err}`);
      }
    }
  }
}

// ── the slice of isomorphic-git's index API used above (its types are loose) ──

interface IndexEntry {
  oid: string;
  mode: number;
  size: number;
  mtimeSeconds: number;
  mtimeNanoseconds: number;
  [field: string]: unknown;
}

/** Whether a file still has the size and modified time its index entry recorded. */
function statMatches(entry: IndexEntry, stats: fs.Stats): boolean {
  const [seconds, nanoseconds] = indexTime(stats.mtimeMs);
  return entry.size === stats.size % UINT32 && entry.mtimeSeconds === seconds && entry.mtimeNanoseconds === nanoseconds;
}

interface IndexLike {
  entriesMap: Map<string, IndexEntry>;
  has(args: { filepath: string }): boolean;
  insert(args: { filepath: string; oid: string; stats: unknown }): void;
  delete(args: { filepath: string }): void;
}
