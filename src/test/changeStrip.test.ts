import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { computeStripMarks, countLines } from '../changeStrip';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

describe('countLines', () => {
  it('counts lines, ignoring a final newline', () => {
    assert.equal(countLines(''), 0);
    assert.equal(countLines('a'), 1);
    assert.equal(countLines('a\n'), 1);
    assert.equal(countLines('a\nb'), 2);
    assert.equal(countLines('a\nb\n'), 2);
    assert.equal(countLines('\n'), 1);
    assert.equal(countLines('a\r\nb\r\n'), 2);
  });
});

describe('computeStripMarks', () => {
  it('places an added block by its position in the file', () => {
    const [m] = computeStripMarks([{ newStart: 26, newLines: 10, oldLines: 0 }], 100);
    close(m.start, 0.25);
    close(m.end, 0.35);
    assert.equal(m.kind, 'added');
  });

  it('classifies removed-only and mixed hunks', () => {
    const marks = computeStripMarks([
      { newStart: 1, newLines: 0, oldLines: 4 },
      { newStart: 50, newLines: 3, oldLines: 3 },
    ], 100);
    assert.deepEqual(marks.map(m => m.kind), ['removed', 'changed']);
  });

  it('gives a pure deletion no width of its own (the view draws a minimum)', () => {
    const [m] = computeStripMarks([{ newStart: 41, newLines: 0, oldLines: 7 }], 100);
    close(m.start, 0.4);
    assert.equal(m.end, m.start);
    assert.equal(m.kind, 'removed');
  });

  it('draws a new file as a fully green bar', () => {
    const [m] = computeStripMarks([{ newStart: 1, newLines: 30, oldLines: 0 }], 30);
    assert.deepEqual(m, { start: 0, end: 1, kind: 'added' });
  });

  it('draws a deleted file as a fully red bar, whatever the hunks say', () => {
    assert.deepEqual(computeStripMarks([{ newStart: 1, newLines: 0, oldLines: 12 }], 12, true), [{ start: 0, end: 1, kind: 'removed' }]);
    assert.deepEqual(computeStripMarks([], 12, true), [{ start: 0, end: 1, kind: 'removed' }]);
  });

  it('has no marks without hunks (for example a new empty file)', () => {
    assert.deepEqual(computeStripMarks([], 0), []);
  });

  it('merges marks that would touch, keeping one kind or becoming changed', () => {
    const marks = computeStripMarks([
      { newStart: 10, newLines: 1, oldLines: 0 },
      { newStart: 11, newLines: 1, oldLines: 0 },
      { newStart: 12, newLines: 0, oldLines: 2 },
    ], 1000);
    assert.equal(marks.length, 1);
    assert.equal(marks[0].kind, 'changed');
    close(marks[0].start, 9 / 1000);
    close(marks[0].end, 11 / 1000);
  });

  it('keeps far-apart marks separate and ordered', () => {
    const marks = computeStripMarks([
      { newStart: 900, newLines: 2, oldLines: 0 },
      { newStart: 5, newLines: 2, oldLines: 0 },
    ], 1000);
    assert.equal(marks.length, 2);
    assert.ok(marks[0].start < marks[1].start);
  });

  it('keeps marks inside 0..1 even for stale or odd positions', () => {
    const marks = computeStripMarks([{ newStart: 500, newLines: 10, oldLines: 0 }], 100);
    assert.ok(marks[0].start <= 1 && marks[0].end <= 1 && marks[0].start >= 0);
    assert.deepEqual(computeStripMarks([{ newStart: 1, newLines: 1, oldLines: 0 }], 0).length, 1);
  });
});
