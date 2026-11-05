import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { removeDirSync } from '../fsUtil';

describe('removeDirSync', () => {
  it('removes a tree containing read-only files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hunktracker-rm-'));
    const sub = path.join(root, 'objects', 'ab');
    fs.mkdirSync(sub, { recursive: true });
    const file = path.join(sub, 'blob');
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, 0o444);
    removeDirSync(root);
    assert.ok(!fs.existsSync(root));
  });

  it('does nothing for a missing directory', () => {
    removeDirSync(path.join(os.tmpdir(), 'hunktracker-does-not-exist-xyz'));
  });
});
