import * as vscode from 'vscode';
import { cleanPatternList } from './ignorePatterns';

/**
 * Plugin-wide (user-level) settings, stored in VS Code's own settings rather than
 * in a project's `settings.json` (in the extension's per-workspace storage). Both are declared in
 * package.json with `"scope": "application"`, so they apply to every project and
 * cannot be overridden per workspace.
 */
export type UserSettingKey = 'autoRevealPanel' | 'autoAcceptOnStartup';

export function getUserSetting(key: UserSettingKey): boolean {
  return vscode.workspace.getConfiguration('hunktracker').get<boolean>(key, false) === true;
}

export function setUserSetting(key: UserSettingKey, value: boolean): Thenable<void> {
  return vscode.workspace.getConfiguration('hunktracker')
    .update(key, value, vscode.ConfigurationTarget.Global);
}

/** Exclude patterns that apply to every project (merged with each project's own list). */
export function getGlobalIgnorePatterns(): string[] {
  return cleanPatternList(vscode.workspace.getConfiguration('hunktracker').get<unknown>('globalIgnorePatterns', []));
}

export function setGlobalIgnorePatterns(patterns: string[]): Thenable<void> {
  const clean = cleanPatternList(patterns);
  // undefined removes the entry, so an empty list goes back to the declared default
  return vscode.workspace.getConfiguration('hunktracker')
    .update('globalIgnorePatterns', clean.length ? clean : undefined, vscode.ConfigurationTarget.Global);
}

/**
 * Command that opens the pane to return to after autoRevealPanel hides hunktracker,
 * or '' for none. Same scope as the settings above.
 */
export function getReturnToView(): string {
  const value = vscode.workspace.getConfiguration('hunktracker').get<string>('returnToView', '');
  return typeof value === 'string' ? value.trim() : '';
}

export function setReturnToView(value: string): Thenable<void> {
  // undefined removes the entry, so "none" goes back to the declared default
  return vscode.workspace.getConfiguration('hunktracker')
    .update('returnToView', value || undefined, vscode.ConfigurationTarget.Global);
}
