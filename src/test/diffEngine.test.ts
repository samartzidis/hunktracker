import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeHunks, hunkId, findAdjacentHunk } from '../diffEngine';

describe('computeHunks', () => {
  it('returns empty for identical content', () => {
    assert.deepEqual(computeHunks('a\nb\n', 'a\nb\n'), []);
  });

  it('returns empty for both empty', () => {
    assert.deepEqual(computeHunks('', ''), []);
  });

  it('detects a single line addition', () => {
    const hunks = computeHunks('a\nb\n', 'a\nb\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.deepEqual(hunks[0].addedContent, ['c']);
    assert.deepEqual(hunks[0].removedContent, []);
  });

  it('detects a single line removal', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nb\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 0);
    assert.equal(hunks[0].oldLines, 1);
    assert.deepEqual(hunks[0].removedContent, ['c']);
  });

  it('detects a line replacement', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nX\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 1);
    assert.equal(hunks[0].oldLines, 1);
    assert.deepEqual(hunks[0].addedContent, ['X']);
    assert.deepEqual(hunks[0].removedContent, ['b']);
  });

  it('detects multiple separate hunks', () => {
    const baseline = 'a\nb\nc\nd\ne\n';
    const current  = 'A\nb\nc\nd\nE\n';
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks.length, 2);
    assert.deepEqual(hunks[0].addedContent, ['A']);
    assert.deepEqual(hunks[1].addedContent, ['E']);
  });

  it('treats entire new content as one hunk when baseline is empty', () => {
    const hunks = computeHunks('', 'hello\nworld\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.equal(hunks[0].newLines, 2);
    assert.equal(hunks[0].newStart, 1);
  });

  it('treats entire deletion as one hunk when current is empty', () => {
    const hunks = computeHunks('hello\nworld\n', '');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 0);
    assert.equal(hunks[0].oldLines, 2);
  });

  // ── null baseline tests (file did not exist before) ──────────────────────
  it('null baseline with content treats as new file (same as empty baseline)', () => {
    const hunks = computeHunks(null, 'hello\nworld\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.equal(hunks[0].newLines, 2);
    assert.equal(hunks[0].newStart, 1);
  });

  it('null baseline with empty current returns no hunks', () => {
    const hunks = computeHunks(null, '');
    assert.equal(hunks.length, 0);
  });

  it('null baseline behaves identically to empty string baseline for diff', () => {
    const content = 'line1\nline2\nline3\n';
    const hunksNull = computeHunks(null, content);
    const hunksEmpty = computeHunks('', content);
    assert.deepEqual(hunksNull, hunksEmpty);
  });

  it('computes correct newStart line numbers', () => {
    const baseline = 'a\nb\nc\n';
    const current  = 'a\nb\nX\n';
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks[0].newStart, 3);
    assert.equal(hunks[0].oldStart, 3);
  });

  it('adjacent changes are merged into one hunk', () => {
    const hunks = computeHunks('a\nb\n', 'X\nY\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 2);
    assert.equal(hunks[0].newLines, 2);
  });

  it('content without trailing newline', () => {
    const hunks = computeHunks('a\nb', 'a\nX');
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].removedContent, ['b']);
    assert.deepEqual(hunks[0].addedContent, ['X']);
  });

  it('insertion at the beginning', () => {
    const hunks = computeHunks('b\nc\n', 'a\nb\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newStart, 1);
    assert.equal(hunks[0].oldStart, 1);
    assert.equal(hunks[0].newLines, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.deepEqual(hunks[0].addedContent, ['a']);
  });

  it('deletion at the beginning', () => {
    const hunks = computeHunks('a\nb\nc\n', 'b\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newStart, 1);
    assert.equal(hunks[0].newLines, 0);
    assert.deepEqual(hunks[0].removedContent, ['a']);
  });

  it('insertion at the end', () => {
    const hunks = computeHunks('a\nb\n', 'a\nb\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.deepEqual(hunks[0].addedContent, ['c']);
  });

  it('deletion at the end', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nb\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 0);
    assert.equal(hunks[0].oldLines, 1);
    assert.deepEqual(hunks[0].removedContent, ['c']);
  });

  it('multiple non-adjacent hunks preserve correct line numbers', () => {
    // Change line 1 and line 5; lines 2-4 are context
    const baseline = '1\n2\n3\n4\n5\n';
    const current  = 'X\n2\n3\n4\nY\n';
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks.length, 2);
    assert.equal(hunks[0].newStart, 1);
    assert.equal(hunks[0].oldStart, 1);
    assert.equal(hunks[1].newStart, 5);
    assert.equal(hunks[1].oldStart, 5);
  });

  it('pure insertion (no removed lines) in the middle', () => {
    const hunks = computeHunks('a\nc\n', 'a\nb\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.equal(hunks[0].newLines, 1);
    assert.deepEqual(hunks[0].addedContent, ['b']);
  });

  it('pure deletion (no added lines) in the middle', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 1);
    assert.equal(hunks[0].newLines, 0);
    assert.deepEqual(hunks[0].removedContent, ['b']);
  });

  it('large block replacement', () => {
    const baseline = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const current  = 'NEW\n';
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 10);
    assert.equal(hunks[0].newLines, 1);
  });
});  // end computeHunks

describe('hunkId', () => {
  it('produces stable id from hunk fields', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nX\nc\n');
    const id = hunkId(hunks[0]);
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
    // Same hunk always produces the same id
    assert.equal(hunkId(hunks[0]), id);
  });

  it('different hunks have different ids', () => {
    const baseline = 'a\nb\nc\nd\ne\n';
    const current  = 'A\nb\nc\nd\nE\n';
    const hunks = computeHunks(baseline, current);
    assert.notEqual(hunkId(hunks[0]), hunkId(hunks[1]));
  });

  it('id format is newStart:newLines:oldStart:oldLines', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nX\nc\n');
    const h = hunks[0];
    assert.equal(hunkId(h), `${h.newStart}:${h.newLines}:${h.oldStart}:${h.oldLines}`);
  });
});

describe('findAdjacentHunk', () => {
  // Three separated hunks: lines 1-2, 5, and 9-10
  const baseline = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n') + '\n';
  const current = ['A', 'B', 'c', 'd', 'E', 'f', 'g', 'h', 'I', 'J'].join('\n') + '\n';
  const hunks = computeHunks(baseline, current);

  it('fixture has three hunks', () => {
    assert.deepEqual(hunks.map(h => h.newStart), [1, 5, 9]);
  });

  it('next from before the first hunk returns the first hunk', () => {
    assert.equal(findAdjacentHunk(hunks, 0, 'next')?.newStart, 1);
  });

  it('next from the start of a hunk skips to the following hunk', () => {
    assert.equal(findAdjacentHunk(hunks, 1, 'next')?.newStart, 5);
  });

  it('next from inside a multi-line hunk returns the following hunk', () => {
    assert.equal(findAdjacentHunk(hunks, 2, 'next')?.newStart, 5);
  });

  it('next after the last hunk returns undefined', () => {
    assert.equal(findAdjacentHunk(hunks, 9, 'next'), undefined);
  });

  it('prev from after the last hunk returns the last hunk', () => {
    assert.equal(findAdjacentHunk(hunks, 20, 'prev')?.newStart, 9);
  });

  it('prev from inside a multi-line hunk returns the preceding hunk, not itself', () => {
    assert.equal(findAdjacentHunk(hunks, 10, 'prev')?.newStart, 5);
  });

  it('prev from the start of a hunk returns the preceding hunk', () => {
    assert.equal(findAdjacentHunk(hunks, 5, 'prev')?.newStart, 1);
  });

  it('prev from the first hunk returns undefined', () => {
    assert.equal(findAdjacentHunk(hunks, 1, 'prev'), undefined);
    assert.equal(findAdjacentHunk(hunks, 2, 'prev'), undefined);
  });

  it('returns undefined for an empty hunk list', () => {
    assert.equal(findAdjacentHunk([], 5, 'next'), undefined);
    assert.equal(findAdjacentHunk([], 5, 'prev'), undefined);
  });

  it('treats a deletion-only hunk (newLines = 0) as one line tall', () => {
    const del = computeHunks('a\nb\nc\nd\n', 'a\nd\n');
    assert.equal(del.length, 1);
    assert.equal(del[0].newLines, 0);
    assert.equal(findAdjacentHunk(del, del[0].newStart + 1, 'prev')?.newStart, del[0].newStart);
    assert.equal(findAdjacentHunk(del, del[0].newStart, 'prev'), undefined);
  });
});
