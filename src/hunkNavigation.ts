import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StateManager } from './stateManager';
import { ReviewPanel } from './reviewPanel';
import { computeHunks, findAdjacentHunk, hunkId, HunkDirection, ParsedHunk } from './diffEngine';
import { sortFiles } from './fileOrder';
import { log } from './log';

/** Where to navigate from. When omitted, the active editor's cursor is used. */
export interface NavigationOrigin {
  filePath: string;
  /** 1-based line in the current content */
  line: number;
}

interface FileHunks {
  filePath: string;
  hunks: ParsedHunk[];
}

function currentText(filePath: string): string | undefined {
  const open = vscode.workspace.textDocuments.find(
    d => d.uri.scheme === 'file' && d.uri.fsPath === filePath
  );
  if (open) return open.getText();
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined; // deleted or unreadable — nothing to navigate to
  }
}

/** Reviewing files that still have hunks on disk, in a stable path order. */
function collectFilesWithHunks(stateManager: StateManager): FileHunks[] {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const result: FileHunks[] = [];
  for (const [filePath, state] of stateManager.getAllFiles()) {
    if (state.status !== 'reviewing') continue;
    const text = currentText(filePath);
    if (text === undefined) continue;
    const hunks = computeHunks(state.baseline, text);
    if (hunks.length > 0) result.push({ filePath, hunks });
  }
  // Same order as the review panel list (see fileOrder.ts)
  return sortFiles(result, f => path.relative(root, f.filePath));
}

function originFromActiveEditor(stateManager: StateManager): NavigationOrigin | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return undefined;
  const filePath = editor.document.uri.fsPath;
  if (!stateManager.isReviewing(filePath)) return undefined;
  return { filePath, line: editor.selection.active.line + 1 };
}

/**
 * Move to the next/previous hunk. Steps through the hunks of the origin file
 * first, then continues into the adjacent file with pending hunks, wrapping
 * around at either end of the file list.
 */
export async function navigateHunk(
  stateManager: StateManager,
  reviewPanel: ReviewPanel,
  direction: HunkDirection,
  origin?: NavigationOrigin
): Promise<void> {
  if (!stateManager.enabled) {
    void vscode.window.showInformationMessage('Hunk Tracker is not enabled. Run "Hunk Tracker: Enable" first.');
    return;
  }

  const files = collectFilesWithHunks(stateManager);
  if (files.length === 0) {
    void vscode.window.setStatusBarMessage('Hunk Tracker: no pending hunks', 3000);
    return;
  }

  const from = origin ?? originFromActiveEditor(stateManager);
  const fileIndex = from ? files.findIndex(f => f.filePath === from.filePath) : -1;

  let target: { file: FileHunks; hunk: ParsedHunk } | undefined;
  let wrapped = false;

  if (from && fileIndex >= 0) {
    const hunk = findAdjacentHunk(files[fileIndex].hunks, from.line, direction);
    if (hunk) target = { file: files[fileIndex], hunk };
  }

  if (!target) {
    // Nothing further in this file (or no usable origin): go to the adjacent file.
    let nextIndex: number;
    if (fileIndex < 0) {
      nextIndex = direction === 'next' ? 0 : files.length - 1;
    } else if (direction === 'next') {
      nextIndex = (fileIndex + 1) % files.length;
      wrapped = nextIndex <= fileIndex;
    } else {
      nextIndex = (fileIndex - 1 + files.length) % files.length;
      wrapped = nextIndex >= fileIndex;
    }
    const file = files[nextIndex];
    target = { file, hunk: direction === 'next' ? file.hunks[0] : file.hunks[file.hunks.length - 1] };
  }

  const position = target.file.hunks.indexOf(target.hunk) + 1;
  const where = `${path.basename(target.file.filePath)}: hunk ${position}/${target.file.hunks.length}`;
  log(`navigateHunk(${direction}): ${where}${wrapped ? ' (wrapped)' : ''}`);
  await reviewPanel.openHunk(target.file.filePath, hunkId(target.hunk));
  void vscode.window.setStatusBarMessage(
    `Hunk Tracker: ${where}${wrapped ? ' — wrapped around' : ''}`, 3000
  );
}

function isNavigationOrigin(arg: unknown): arg is NavigationOrigin {
  const a = arg as Partial<NavigationOrigin> | undefined;
  return !!a && typeof a.filePath === 'string' && typeof a.line === 'number';
}

export function registerHunkNavigation(
  context: vscode.ExtensionContext,
  stateManager: StateManager,
  reviewPanel: ReviewPanel
): void {
  // Menu and keybinding invocations pass no (or unrelated) arguments; only the
  // inline action bar passes an explicit origin.
  const register = (command: string, direction: HunkDirection) =>
    vscode.commands.registerCommand(command, (arg?: unknown) =>
      navigateHunk(stateManager, reviewPanel, direction, isNavigationOrigin(arg) ? arg : undefined)
    );

  context.subscriptions.push(
    register('hunktracker.nextHunk', 'next'),
    register('hunktracker.prevHunk', 'prev'),
  );
}
