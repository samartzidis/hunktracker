import * as fs from 'fs';

/**
 * Files bigger than this are not tracked: no baseline is stored for them, they never show up as new
 * files and changes to them are ignored. They are almost always binaries (executables, archives,
 * databases, media), which cannot be reviewed hunk by hunk, and reading them whole would cost far more
 * memory and time than the rest of a project put together.
 */
export const MAX_TRACKED_FILE_BYTES = 10 * 1024 * 1024;

/** Whether a size in bytes is over the limit. */
export function isOverSizeLimit(sizeInBytes: number): boolean {
  return sizeInBytes > MAX_TRACKED_FILE_BYTES;
}

/** Whether the file at `filePath` is over the limit. False when it cannot be inspected (missing, no access). */
export async function isFileOverSizeLimit(filePath: string): Promise<boolean> {
  try {
    return isOverSizeLimit((await fs.promises.stat(filePath)).size);
  } catch {
    return false;
  }
}
