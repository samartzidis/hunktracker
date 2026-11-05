/**
 * Layout for the little "where in the file" strip shown on each row of the review list:
 * a thin bar standing for the whole file, with a mark for every pending change. Purely visual.
 * Positions are fractions of the file (0..1) so the webview only has to scale them.
 *
 * Vscode-free so it can be unit-tested.
 */

export type StripKind = 'added' | 'removed' | 'changed';

export interface StripMark {
  /** Left edge, 0..1 of the file. */
  start: number;
  /** Right edge, 0..1 (the view draws a minimum width, so a pure deletion can have end === start). */
  end: number;
  /** added: only new lines. removed: only deleted lines. changed: both (drawn half red, half green). */
  kind: StripKind;
}

interface HunkLike {
  newStart: number;
  newLines: number;
  oldLines: number;
}

/** Marks closer than this (as a fraction of the file) are drawn as one. About one pixel on a ~48 px strip. */
const MERGE_GAP = 1 / 96;

/** Number of lines in `text` (a trailing newline does not start another line); 0 for ''. */
export function countLines(text: string): number {
  if (text === '') return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && i < text.length - 1) lines++;
  return lines;
}

function kindOf(h: HunkLike): StripKind {
  if (h.oldLines === 0) return 'added';
  if (h.newLines === 0) return 'removed';
  return 'changed';
}

function combine(a: StripKind, b: StripKind): StripKind {
  return a === b ? a : 'changed';
}

/**
 * @param hunks      pending hunks, positions in the file as it is now (1-based `newStart`)
 * @param totalLines lines in the file as it is now (baseline line count for a deleted file)
 * @param isDeleted  file is gone from disk: the whole bar is red
 */
export function computeStripMarks(hunks: HunkLike[], totalLines: number, isDeleted = false): StripMark[] {
  if (isDeleted) return [{ start: 0, end: 1, kind: 'removed' }];
  if (hunks.length === 0) return [];

  const n = Math.max(1, totalLines);
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const marks: StripMark[] = hunks
    .map(h => {
      const start = clamp((h.newStart - 1) / n);
      const end = clamp((h.newStart - 1 + h.newLines) / n);
      return { start, end: Math.max(start, end), kind: kindOf(h) };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: StripMark[] = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m.start <= last.end + MERGE_GAP) {
      last.end = Math.max(last.end, m.end);
      last.kind = combine(last.kind, m.kind);
    } else {
      merged.push({ ...m });
    }
  }
  return merged;
}
