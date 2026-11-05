/**
 * Display order of the files under review. Shared by the review panel and by next/prev hunk
 * navigation so the arrows walk the files in the order the list shows them.
 *
 * Pure (no vscode import) so it can be unit tested.
 */

/** How the review list is ordered. Only 'location' exists so far; add modes here. */
export type SortMode = 'location';

export const DEFAULT_SORT_MODE: SortMode = 'location';

// numeric: file2 < file10; base sensitivity: case and accents do not decide the order
// (Windows paths are case-insensitive, and Explorer sorts the same way).
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Compare two names; fall back to a plain comparison so names differing only by case still order deterministically. */
function compareNames(a: string, b: string): number {
  const c = collator.compare(a, b);
  if (c !== 0) return c;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare filenames by name first and extension second, so `cert_manager.tf` comes before
 * `cert_manager_key_vault_sync.tf`: compared whole, the collator ranks `_` before `.` and would
 * put the longer name first. A leading dot (`.gitignore`) belongs to the name, not an extension.
 */
function compareFileNames(a: string, b: string): number {
  const split = (n: string): [string, string] => {
    const i = n.lastIndexOf('.');
    return i > 0 ? [n.slice(0, i), n.slice(i + 1)] : [n, ''];
  };
  const [stemA, extA] = split(a);
  const [stemB, extB] = split(b);
  return compareNames(stemA, stemB) || compareNames(extA, extB) || compareNames(a, b);
}

/**
 * Order as in the VS Code Explorer: walking the path level by level, subfolders come before
 * files, each group sorted by name. All files of a folder stay together:
 *   a/b/x.tf, a/x.tf, a/y.tf, c/x.tf, root.txt
 * (A whole-path string compare does not guarantee this: punctuation such as `_` `.` `\` takes part
 * in the comparison, so files of neighbouring folders can interleave.)
 */
export function compareByLocation(relA: string, relB: string): number {
  const a = relA.split(/[\\/]+/);
  const b = relB.split(/[\\/]+/);

  for (let i = 0; ; i++) {
    const aIsDir = i < a.length - 1;
    const bIsDir = i < b.length - 1;
    if (aIsDir && bIsDir) {
      const c = compareNames(a[i], b[i]);
      if (c !== 0) return c;
      continue; // same folder, look one level deeper
    }
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1; // folder before file
    return compareFileNames(a[i], b[i]);
  }
}

/**
 * Return `items` ordered for display (a sorted copy; the input is not modified).
 * `relPath` gives the workspace-relative path of an item.
 */
export function sortFiles<T>(items: readonly T[], relPath: (item: T) => string, mode: SortMode = DEFAULT_SORT_MODE): T[] {
  const sorted = items.slice();
  switch (mode) {
    case 'location':
      return sorted.sort((x, y) => compareByLocation(relPath(x), relPath(y)));
  }
}
