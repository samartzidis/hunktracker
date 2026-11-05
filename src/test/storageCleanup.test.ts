import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { findOrphanedStorage, scanStorage, removeOrphanedStorage, sweepOrphanedStorage, describeSweep, projectPathOf, formatBytes, type SweepResult } from '../storageCleanup';

const OWNER = 'GeorgeSamartzidis.hunktracker';

let tmp: string;
let root: string; // <tmp>/User/workspaceStorage
let projects: string; // <tmp>/projects

/** Create <root>/<id>/workspace.json (+ optional extension folders with one file each). */
function entry(id: string, workspaceJson: object | undefined, extensions: string[] = [OWNER]): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  if (workspaceJson) fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(workspaceJson));
  for (const ext of extensions) {
    fs.mkdirSync(path.join(dir, ext, 'git'), { recursive: true });
    fs.writeFileSync(path.join(dir, ext, 'settings.json'), '{}');
    fs.writeFileSync(path.join(dir, ext, 'git', 'HEAD'), 'ref: refs/heads/main');
  }
  return path.join(dir, OWNER);
}

function project(name: string, exists: boolean): { folder: string } {
  const p = path.join(projects, name);
  if (exists) fs.mkdirSync(p, { recursive: true });
  return { folder: pathToFileURL(p).toString() };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-cleanup-'));
  root = path.join(tmp, 'User', 'workspaceStorage');
  projects = path.join(tmp, 'projects');
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('projectPathOf', () => {
  it('reads folder and workspace entries', () => {
    const p = path.join(tmp, 'a b');
    assert.equal(projectPathOf(JSON.stringify({ folder: pathToFileURL(p).toString() })), p);
    assert.equal(projectPathOf(JSON.stringify({ workspace: pathToFileURL(p + '.code-workspace').toString() })), p + '.code-workspace');
  });

  it('decodes the drive colon the way VS Code writes it', { skip: process.platform !== 'win32' }, () => {
    assert.equal(projectPathOf('{"folder": "file:///c%3A/Temp/my%20app"}'), 'c:\\Temp\\my app');
  });

  it('gives up on remote, malformed and unknown shapes', () => {
    assert.equal(projectPathOf('{"folder": "vscode-remote://wsl+ubuntu/mnt/c/x"}'), undefined);
    assert.equal(projectPathOf('not json'), undefined);
    assert.equal(projectPathOf('{}'), undefined);
    assert.equal(projectPathOf('{"folder": 5}'), undefined);
  });
});

describe('findOrphanedStorage', () => {
  it('returns only entries whose local project is gone', async () => {
    const own = entry('own', project('current', true));
    entry('alive', project('alive', true));
    const deadDir = entry('dead', project('dead', false));
    entry('remote', { folder: 'vscode-remote://wsl+ubuntu/mnt/c/x' });
    entry('nojson', undefined);

    const found = await findOrphanedStorage(own);
    assert.deepEqual(found.map(f => f.dir), [deadDir]);
    assert.equal(path.basename(found[0].projectPath), 'dead');
    assert.ok(found[0].bytes > 0);
  });

  it('never returns the current entry even if its project looks missing', async () => {
    const own = entry('own', project('gone-but-open', false));
    assert.deepEqual(await findOrphanedStorage(own), []);
  });

  it('ignores entries that have no folder of this extension', async () => {
    const own = entry('own', project('current', true));
    entry('other-ext-only', project('dead', false), ['someone.else']);
    assert.deepEqual(await findOrphanedStorage(own), []);
  });

  it('treats a missing .code-workspace file as a deleted project', async () => {
    const own = entry('own', project('current', true));
    const dir = entry('ws', { workspace: pathToFileURL(path.join(projects, 'gone.code-workspace')).toString() });
    assert.deepEqual((await findOrphanedStorage(own)).map(f => f.dir), [dir]);
  });

  it('does nothing when the layout is not <...>/workspaceStorage/<id>/<ext>', async () => {
    const odd = path.join(tmp, 'elsewhere', 'id1', OWNER);
    fs.mkdirSync(odd, { recursive: true });
    const other = path.join(tmp, 'elsewhere', 'id2', OWNER);
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'elsewhere', 'id2', 'workspace.json'), JSON.stringify(project('dead', false)));
    assert.deepEqual(await findOrphanedStorage(odd), []);
  });
});

describe('removeOrphanedStorage', () => {
  it('deletes only this extension folder and keeps everything else', async () => {
    const own = entry('own', project('current', true));
    const deadDir = entry('dead', project('dead', false), [OWNER, 'someone.else']);
    const aliveDir = entry('alive', project('alive', true));

    const found = await findOrphanedStorage(own);
    const result = await removeOrphanedStorage(found);

    assert.equal(result.removed, 1);
    assert.equal(result.failed, 0);
    assert.ok(result.bytes > 0);
    assert.ok(!fs.existsSync(deadDir), 'orphaned extension folder removed');
    assert.ok(fs.existsSync(path.join(root, 'dead', 'someone.else')), 'other extensions untouched');
    assert.ok(fs.existsSync(path.join(root, 'dead', 'workspace.json')), 'workspace.json untouched');
    assert.ok(fs.existsSync(aliveDir), 'live project untouched');
    assert.ok(fs.existsSync(own), 'current entry untouched');
  });

  it('refuses a path outside a workspaceStorage layout', async () => {
    const stray = path.join(tmp, 'precious', 'x', OWNER);
    fs.mkdirSync(stray, { recursive: true });
    const result = await removeOrphanedStorage([{ dir: stray, projectPath: '/gone', bytes: 1 }]);
    assert.equal(result.removed, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].dir, stray);
    assert.match(result.failures[0].error, /refused/);
    assert.ok(fs.existsSync(stray));
  });

  it('records the path and reason when a removal throws', async () => {
    const bad = path.join(root, 'x', OWNER + '\0bad'); // a NUL in the path makes fs throw
    const result = await removeOrphanedStorage([{ dir: bad, projectPath: '/gone', bytes: 7 }]);
    assert.equal(result.removed, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.bytes, 0);
    assert.equal(result.failures[0].dir, bad);
    assert.ok(result.failures[0].error.length > 0);
  });
});

describe('sweepOrphanedStorage', () => {
  it('finds and deletes in one call, with no grace period', async () => {
    const own = entry('own', project('current', true));
    const deadDir = entry('dead', project('dead', false));
    const aliveDir = entry('alive', project('alive', true));

    const result = await sweepOrphanedStorage(own);

    assert.equal(result.removed, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.projects.map(p => path.basename(p)), ['dead']);
    assert.ok(!fs.existsSync(deadDir));
    assert.ok(fs.existsSync(aliveDir));
    assert.ok(fs.existsSync(own));
    // a second sweep finds nothing left to do
    assert.deepEqual((await sweepOrphanedStorage(own)).removed, 0);
  });
});

describe('scanStorage', () => {
  it('counts what it checked and what it skipped, and why', async () => {
    const own = entry('own', project('current', true));
    entry('alive', project('alive', true));
    entry('dead', project('dead', false));
    entry('remote', { folder: 'vscode-remote://wsl+ubuntu/mnt/c/x' });
    entry('nojson', undefined);
    entry('other-ext-only', project('dead2', false), ['someone.else']); // not ours: not counted

    const scan = await scanStorage(own);
    assert.equal(scan.problem, undefined);
    assert.equal(scan.checked, 4); // alive, dead, remote, nojson
    assert.equal(scan.orphans.length, 1);
    assert.equal(scan.skippedRemote, 1);
    assert.equal(scan.skippedUnreadable, 1);
    assert.equal(scan.skippedUnreachable, 0);
  });

  it('reports a problem instead of silently doing nothing on an unexpected layout', async () => {
    const odd = path.join(tmp, 'elsewhere', 'id1', OWNER);
    fs.mkdirSync(odd, { recursive: true });
    const scan = await scanStorage(odd);
    assert.match(scan.problem ?? '', /unexpected storage layout/);
    assert.equal(scan.orphans.length, 0);
  });
});

const sweepResult = (over: Partial<SweepResult> = {}): SweepResult => ({
  removed: 0, failed: 0, bytes: 0, failures: [], projects: [],
  scan: { orphans: [], checked: 0, skippedRemote: 0, skippedUnreadable: 0, skippedUnreachable: 0 },
  ...over,
});

describe('describeSweep', () => {
  it('says so when there was nothing to remove', () => {
    const lines = describeSweep(sweepResult({ scan: { orphans: [], checked: 12, skippedRemote: 2, skippedUnreadable: 0, skippedUnreachable: 1 } }));
    assert.deepEqual(lines, ['storage sweep: nothing to remove (checked 12 other workspaces, skipped 2 remote, 1 on an unreachable drive)']);
  });

  it('summarises a successful removal with the projects that were gone', () => {
    const orphan = { dir: 'd', projectPath: 'c:\\gone\\app', bytes: 2048 };
    const [line] = describeSweep(sweepResult({
      removed: 1, bytes: 2048, projects: [orphan.projectPath],
      scan: { orphans: [orphan], checked: 3, skippedRemote: 0, skippedUnreadable: 0, skippedUnreachable: 0 },
    }));
    assert.match(line, /removed 1, failed 0, freed 2\.0 KB/);
    assert.match(line, /checked 3/);
    assert.match(line, /gone: c:\\gone\\app/);
  });

  it('adds one line per failure with the path and the reason', () => {
    const orphan = { dir: 'x/dir', projectPath: '/gone', bytes: 1 };
    const lines = describeSweep(sweepResult({
      failed: 1, failures: [{ dir: 'x/dir', error: 'EBUSY: resource busy' }], projects: ['/gone'],
      scan: { orphans: [orphan], checked: 1, skippedRemote: 0, skippedUnreadable: 0, skippedUnreachable: 0 },
    }));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /removed 0, failed 1/);
    assert.equal(lines[1], 'storage sweep: could not remove x/dir: EBUSY: resource busy');
  });

  it('reports a scan problem', () => {
    const lines = describeSweep(sweepResult({ scan: { orphans: [], checked: 0, skippedRemote: 0, skippedUnreadable: 0, skippedUnreachable: 0, problem: 'unexpected storage layout (x), nothing checked' } }));
    assert.deepEqual(lines, ['storage sweep: unexpected storage layout (x), nothing checked']);
  });
});

describe('formatBytes', () => {
  it('formats sizes', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
    assert.equal(formatBytes(300 * 1024 * 1024), '300 MB');
  });
});
