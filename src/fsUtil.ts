import * as fs from 'fs';
import * as path from 'path';

/**
 * Recursively removes a directory, including read-only files.
 *
 * Git writes object files read-only, and on Windows `fs.rmSync` then fails with
 * EPERM. On such a failure this clears the read-only flag on every entry and retries once.
 */
export function removeDirSync(dir: string): void {
  // First try without retries: the common EPERM cause (read-only git objects) is fixed by
  // makeWritable below, and Node's retry loop would block the thread for ~1.5s before failing.
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES') throw err;
  }
  makeWritable(dir);
  // maxRetries covers transient EPERM/EBUSY (e.g. a watcher or git process still holds a handle).
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * `fs.mkdirSync(recursive)` that retries briefly on EPERM/EBUSY/EACCES.
 *
 * On Windows a just-deleted directory stays "delete pending" while another process
 * (e.g. VS Code's file watcher) still has a handle on it, and creating it again fails
 * with EPERM until the handle is released.
 */
export async function mkdirRetry(dir: string, attempts = 20, delayMs = 100): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function makeWritable(p: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  try {
    fs.chmodSync(p, stat.isDirectory() ? 0o777 : 0o666);
  } catch {
    // best effort; the retried rmSync reports the real error
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(p)) makeWritable(path.join(p, entry));
  }
}
