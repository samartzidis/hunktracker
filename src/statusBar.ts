import * as vscode from 'vscode';
import { StateManager } from './stateManager';

/** Command behind the status bar item: bring the Hunk Tracker pane up (opens its side bar if closed). */
export const SHOW_PANEL_COMMAND = 'hunktracker.showPanel';

/**
 * A status bar item that reveals the Hunk Tracker pane when clicked and shows how many files
 * are waiting for review. The Activity Bar cannot hold a plain command button, so this is the
 * closest equivalent. Shown only while a folder is open.
 */
export class StatusBarItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly stateManager: StateManager) {
    this.item = vscode.window.createStatusBarItem(
      'hunktracker.status',
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.name = 'Hunk Tracker';
    this.item.command = SHOW_PANEL_COMMAND;
    this.refresh();
  }

  /** Call whenever tracked state may have changed. */
  refresh(): void {
    if (!vscode.workspace.workspaceFolders?.length) {
      this.item.hide();
      return;
    }
    let pending = 0;
    if (this.stateManager.enabled) {
      for (const f of this.stateManager.getAllFiles().values()) {
        if (f.status === 'reviewing') pending++;
      }
    }
    this.item.text = pending > 0 ? `$(diff) ${pending}` : '$(diff)';
    this.item.tooltip = !this.stateManager.enabled
      ? 'Hunk Tracker: open the panel'
      : pending > 0
        ? `Hunk Tracker: ${pending} file${pending === 1 ? '' : 's'} with pending changes. Click to open the panel`
        : 'Hunk Tracker: no pending changes. Click to open the panel';
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
