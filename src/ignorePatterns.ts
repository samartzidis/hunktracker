/**
 * Exclude patterns come from two places: the user's global list (`hunktracker.globalIgnorePatterns`,
 * every project) and the project's own list (settings.json in the extension's per-workspace storage).
 * No vscode imports here, so it can be unit tested.
 */

/** What a settings value may hold: keeps trimmed, non-empty strings, drops everything else and repeats. */
export function cleanPatternList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const pattern = item.trim();
    if (pattern && !out.includes(pattern)) out.push(pattern);
  }
  return out;
}

/**
 * The patterns that apply to a project. Global ones come first and the project's after them, so a
 * project can re-include something the global list excludes with a `!pattern` line (gitignore
 * semantics: the last matching line wins).
 */
export function mergeIgnorePatterns(globalPatterns: readonly string[], projectPatterns: readonly string[]): string[] {
  return [...globalPatterns, ...projectPatterns];
}

/**
 * Anything inside a `.git` folder (the project's own or a nested repo's) is never tracked: it is huge,
 * changes constantly, and is git's business. Built in, so it cannot be removed from a list by mistake.
 */
export function isInsideDotGit(relPath: string): boolean {
  return /(^|\/)\.git(\/|$)/.test(relPath);
}

/**
 * Earlier versions stored `.git` as an ordinary pattern in every project's settings.json. It is built in
 * now, so a stored copy is dropped when settings are loaded.
 */
export function withoutBuiltInPatterns(patterns: readonly string[]): string[] {
  return patterns.filter(p => p.trim() !== '.git');
}
