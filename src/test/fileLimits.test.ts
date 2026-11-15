import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  looksBinary, isFileBinary, untrackableReason, BINARY_CHECK_BYTES, MAX_TRACKED_FILE_BYTES,
} from '../fileLimits';

/** `length` bytes of 'a' with a NUL at `nulAt`. */
function withNulAt(length: number, nulAt: number): Buffer {
  const b = Buffer.alloc(length, 'a');
  b[nulAt] = 0;
  return b;
}

describe('fileLimits', () => {
  describe('looksBinary', () => {
    it('text, including non-ASCII UTF-8 and control characters other than NUL, is not binary', () => {
      assert.equal(looksBinary(Buffer.from('plain text\r\n\tαβγ €\x01\x1b[0m\n', 'utf-8')), false);
    });

    it('an empty file is not binary', () => {
      assert.equal(looksBinary(Buffer.alloc(0)), false);
    });

    it('a NUL anywhere in the first BINARY_CHECK_BYTES makes it binary', () => {
      assert.equal(looksBinary(withNulAt(100, 0)), true);
      assert.equal(looksBinary(withNulAt(BINARY_CHECK_BYTES * 2, BINARY_CHECK_BYTES - 1)), true);
    });

    it('a NUL only after the first BINARY_CHECK_BYTES does not', () => {
      assert.equal(looksBinary(withNulAt(BINARY_CHECK_BYTES * 2, BINARY_CHECK_BYTES)), false);
    });

    it('UTF-16 text counts as binary', () => {
      assert.equal(looksBinary(Buffer.from('﻿hello', 'utf16le')), true);
    });
  });

  describe('on disk', () => {
    let dir: string;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-limits-')); });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
    const file = (name: string, content: Buffer | string) => {
      const fp = path.join(dir, name);
      fs.writeFileSync(fp, content);
      return fp;
    };

    it('isFileBinary reads only the beginning of the file', async () => {
      assert.equal(await isFileBinary(file('early.bin', withNulAt(BINARY_CHECK_BYTES * 3, 10))), true);
      assert.equal(await isFileBinary(file('late.txt', withNulAt(BINARY_CHECK_BYTES * 3, BINARY_CHECK_BYTES + 5))), false);
      assert.equal(await isFileBinary(file('short.txt', 'short\n')), false);
    });

    it('isFileBinary is false for a file that cannot be read', async () => {
      assert.equal(await isFileBinary(path.join(dir, 'missing.bin')), false);
      assert.equal(await isFileBinary(dir), false);
    });

    it('untrackableReason names the reason, size first', async () => {
      assert.equal(await untrackableReason(file('text.txt', 'text\n')), undefined);
      assert.equal(await untrackableReason(file('tool.exe', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]))), 'binary');
      assert.equal(await untrackableReason(file('big.bin', Buffer.alloc(MAX_TRACKED_FILE_BYTES + 1, 0))), 'tooLarge');
      assert.equal(await untrackableReason(path.join(dir, 'missing.txt')), undefined);
    });
  });
});
