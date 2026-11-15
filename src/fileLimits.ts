import * as fs from 'fs';

/**
 * Files bigger than this are not tracked: no baseline is stored for them, they never show up as new
 * files and changes to them are ignored. They are almost always binaries (executables, archives,
 * databases, media), which cannot be reviewed hunk by hunk, and reading them whole would cost far more
 * memory and time than the rest of a project put together.
 */
export const MAX_TRACKED_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Binary files are not tracked either. A file is binary when its first BINARY_CHECK_BYTES contain a
 * NUL byte, the rule git uses. Files are read and compared as UTF-8 text, so a binary file would show
 * garbled hunks, and Discard would write the lossy decoded text back over it. UTF-16 text files
 * contain NUL bytes and count as binary too (they would show garbled as well).
 */
export const BINARY_CHECK_BYTES = 8000;

/** Why a file is not tracked. */
export type UntrackableReason = 'tooLarge' | 'binary';

/** Whether a size in bytes is over the limit. */
export function isOverSizeLimit(sizeInBytes: number): boolean {
  return sizeInBytes > MAX_TRACKED_FILE_BYTES;
}

/** Whether these bytes (a whole file or its beginning) are the start of a binary file. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_CHECK_BYTES).indexOf(0) !== -1;
}

/** Whether the file at `filePath` is binary. Reads only its beginning. False when it cannot be read. */
export async function isFileBinary(filePath: string): Promise<boolean> {
  try {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const head = Buffer.alloc(BINARY_CHECK_BYTES);
      const { bytesRead } = await handle.read(head, 0, BINARY_CHECK_BYTES, 0);
      return looksBinary(head.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/**
 * Why the file at `filePath` is not tracked, or undefined when it is (or when it cannot be inspected:
 * missing, no access). The size is checked first, so a big file is never opened.
 */
export async function untrackableReason(filePath: string): Promise<UntrackableReason | undefined> {
  try {
    if (isOverSizeLimit((await fs.promises.stat(filePath)).size)) return 'tooLarge';
  } catch {
    return undefined;
  }
  return (await isFileBinary(filePath)) ? 'binary' : undefined;
}

/** Log wording for a reason. */
export function describeUntrackable(reason: UntrackableReason): string {
  return reason === 'tooLarge' ? 'over the size limit' : 'binary';
}
