import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { removeDirSync } from './fsUtil';

/**
 * Finds and removes this extension's data for projects that no longer exist.
 *
 * VS Code keeps per-workspace extension data at
 *   <user data>/User/workspaceStorage/<workspace id>/<extension id>/
 * and, next to it, <workspace id>/workspace.json naming the project ({"folder": "file:///..."} or
 * {"workspace": "file:///...code-workspace"}). VS Code does not reliably delete these when the
 * project is deleted, so the folders pile up. The layout is not a documented API: anything that
 * does not match it is left alone, so a layout change makes this do nothing, never delete wrongly.
 *
 * Vscode-free so it can be unit-tested. Callers pass the extension's own `context.storageUri` path.
 */

export interface OrphanedStorage {
  /** The extension's folder inside the orphaned workspace storage entry. */
  dir: string;
  /** The project folder (or .code-workspace file) that no longer exists. */
  projectPath: string;
  bytes: number;
}

/** What a scan looked at. `skipped*` entries were left alone on purpose. */
export interface ScanResult {
  orphans: OrphanedStorage[];
  /** Other workspaces' entries that hold a folder of this extension. */
  checked: number;
  /** Project not judgeable from here: remote (vscode-remote://) or an unknown workspace.json shape. */
  skippedRemote: number;
  /** No readable workspace.json, so whose entry it is cannot be told. */
  skippedUnreadable: number;
  /** Project path missing, but its drive or share is not reachable right now. */
  skippedUnreachable: number;
  /** Set when the scan could not start: unexpected layout or unreadable root. */
  problem?: string;
}

export interface CleanupFailure {
  dir: string;
  error: string;
}

export interface CleanupResult {
  removed: number;
  failed: number;
  bytes: number;
  failures: CleanupFailure[];
}

const STORAGE_ROOT_NAME = 'workspaceStorage';

/** The local project path named by a workspace.json, or undefined (remote, unreadable, unknown shape). */
export function projectPathOf(workspaceJson: string): string | undefined {
  try {
    const parsed = JSON.parse(workspaceJson) as { folder?: unknown; workspace?: unknown };
    const uri = typeof parsed.folder === 'string' ? parsed.folder
      : typeof parsed.workspace === 'string' ? parsed.workspace
      : undefined;
    if (!uri || !uri.startsWith('file:')) return undefined; // vscode-remote:// etc.: cannot judge from here
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

/**
 * Look through the other workspaces' entries for this extension's folders whose project is gone.
 * `ownStorageDir` is `context.storageUri.fsPath`; its own entry is never returned.
 */
export async function scanStorage(ownStorageDir: string): Promise<ScanResult> {
  const result: ScanResult = { orphans: [], checked: 0, skippedRemote: 0, skippedUnreadable: 0, skippedUnreachable: 0 };
  const owner = path.basename(ownStorageDir);
  const ownId = path.basename(path.dirname(ownStorageDir));
  const root = path.dirname(path.dirname(ownStorageDir));
  if (path.basename(root) !== STORAGE_ROOT_NAME) {
    result.problem = `unexpected storage layout (${ownStorageDir}), nothing checked`;
    return result;
  }

  let ids: string[];
  try {
    ids = await fs.promises.readdir(root);
  } catch (err) {
    result.problem = `cannot read ${root}: ${err instanceof Error ? err.message : err}`;
    return result;
  }

  for (const id of ids) {
    if (id === ownId) continue;
    const dir = path.join(root, id, owner);
    if (!fs.existsSync(dir)) continue;
    result.checked++;

    let json: string;
    try {
      json = await fs.promises.readFile(path.join(root, id, 'workspace.json'), 'utf-8');
    } catch {
      result.skippedUnreadable++; // no workspace.json: cannot tell whose it is
      continue;
    }
    const projectPath = projectPathOf(json);
    if (!projectPath) { result.skippedRemote++; continue; }
    if (fs.existsSync(projectPath)) continue;
    // A missing path on a drive or share that is not reachable right now (unplugged, offline)
    // is not a deleted project.
    if (!fs.existsSync(path.parse(projectPath).root)) { result.skippedUnreachable++; continue; }

    result.orphans.push({ dir, projectPath, bytes: await dirSize(dir) });
  }
  result.orphans.sort((a, b) => a.projectPath.localeCompare(b.projectPath));
  return result;
}

/** Just the orphans of a scan. */
export async function findOrphanedStorage(ownStorageDir: string): Promise<OrphanedStorage[]> {
  return (await scanStorage(ownStorageDir)).orphans;
}

/** Delete the folders a scan returned. Only ever removes `<...>/workspaceStorage/<id>/<extension id>`. */
export async function removeOrphanedStorage(items: OrphanedStorage[]): Promise<CleanupResult> {
  const result: CleanupResult = { removed: 0, failed: 0, bytes: 0, failures: [] };
  for (const item of items) {
    if (path.basename(path.dirname(path.dirname(item.dir))) !== STORAGE_ROOT_NAME) {
      result.failed++;
      result.failures.push({ dir: item.dir, error: `refused: not inside a ${STORAGE_ROOT_NAME} folder` });
      continue;
    }
    try {
      removeDirSync(item.dir);
      result.removed++;
      result.bytes += item.bytes;
    } catch (err) {
      result.failed++;
      result.failures.push({ dir: item.dir, error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise<void>(resolve => setImmediate(resolve)); // keep the extension host responsive
  }
  return result;
}

export interface SweepResult extends CleanupResult {
  scan: ScanResult;
  /** Project paths that were gone (removed or not). */
  projects: string[];
}

/** Find and delete leftovers in one go (the automatic sweep). */
export async function sweepOrphanedStorage(ownStorageDir: string): Promise<SweepResult> {
  const scan = await scanStorage(ownStorageDir);
  const result = await removeOrphanedStorage(scan.orphans);
  return { ...result, scan, projects: scan.orphans.map(o => o.projectPath) };
}

/** Log lines for a finished sweep: one summary, plus one line per failed removal. Never empty. */
export function describeSweep(r: SweepResult): string[] {
  const { scan } = r;
  if (scan.problem) return [`storage sweep: ${scan.problem}`];
  const skipped = [
    scan.skippedRemote ? `${scan.skippedRemote} remote` : '',
    scan.skippedUnreadable ? `${scan.skippedUnreadable} unreadable` : '',
    scan.skippedUnreachable ? `${scan.skippedUnreachable} on an unreachable drive` : '',
  ].filter(Boolean);
  const skippedText = skipped.length ? `, skipped ${skipped.join(', ')}` : '';
  const lines: string[] = [];
  if (scan.orphans.length === 0) {
    lines.push(`storage sweep: nothing to remove (checked ${scan.checked} other workspace${scan.checked === 1 ? '' : 's'}${skippedText})`);
  } else {
    lines.push(
      `storage sweep: removed ${r.removed}, failed ${r.failed}, freed ${formatBytes(r.bytes)} ` +
      `(checked ${scan.checked}${skippedText}; gone: ${r.projects.join(', ')})`
    );
  }
  for (const f of r.failures) lines.push(`storage sweep: could not remove ${f.dir}: ${f.error}`);
  return lines;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) {
      try { total += (await fs.promises.stat(full)).size; } catch { /* vanished */ }
    }
  }
  return total;
}
