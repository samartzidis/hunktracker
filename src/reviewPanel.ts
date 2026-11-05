import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StateManager } from './stateManager';
import { FileWatcher } from './fileWatcher';
import { computeHunks, hunkId } from './diffEngine';
import { sortFiles } from './fileOrder';
import { computeStripMarks, countLines, type StripMark } from './changeStrip';
import { log } from './log';
import type { ApiStatus } from './proposedApi';
import { getUserSetting, setUserSetting, getReturnToView, setReturnToView, type UserSettingKey } from './userSettings';
import { collectReturnOptions, type ReturnOption } from './containerOptions';

import {
  acceptAllFiles,
  discardAllFiles,
  acceptFileByPath,
  discardFileByPath,
  acceptHunk,
  discardHunk,
} from './commands';

interface PanelState {
  /** Not 'available': the panel is greyed out and shows setup steps (blocked) or a notice (missing). */
  proposedApiStatus: ApiStatus;
  enabled: boolean;
  ignorePatterns: string[];
  respectGitignore: boolean;
  clearOnBranchSwitch: boolean;
  autoAcceptOnStartup: boolean;
  autoRevealPanel: boolean;
  /** Command that opens the pane to return to after auto-hide ('' = none). */
  returnToView: string;
  returnViewOptions: ReturnOption[];
  useDiffEditor: boolean;
  showInlineDecorations: boolean;
  totalFiles: number;
  totalAdded: number;
  totalRemoved: number;
  files: PanelFile[];
}

interface PanelFile {
  filePath: string;
  fileName: string;
  dirName: string;
  addedLines: number;
  removedLines: number;
  pendingCount: number;
  /** Lines in the file now (baseline lines for a deleted file): the scale of `strip`. */
  totalLines: number;
  /** Where the pending changes sit in the file, for the row's overview strip. */
  strip: StripMark[];
  isNew: boolean;
  isDeleted: boolean;
  hunks: PanelHunk[];
}

interface PanelHunk {
  id: string;
  filePath: string;
  newStart: number;
  newLines: number;
  oldLines: number;
}

export class ReviewPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private _loading: boolean = false;
  private knownPending: Set<string> | undefined;
  private proposedApiStatus: ApiStatus = 'available';
  /** Installed extensions rarely change, so the dropdown list is built once and reused. */
  private returnOptionsCache: ReturnOption[] | undefined;
  /** Outstanding "is the pane still shown?" questions to the webview, by id. */
  private visibilityPings = new Map<number, (shown: boolean) => void>();
  private nextPingId = 0;

  get loading(): boolean { return this._loading; }

  /** Set once at activation, before the view is registered. */
  setProposedApiStatus(status: ApiStatus): void {
    this.proposedApiStatus = status;
  }

  constructor(
    private context: vscode.ExtensionContext,
    private stateManager: StateManager,
    private fileWatcher: FileWatcher,
    private onStateChanged: () => void,
    private onBaselineChanged?: (filePath: string) => void,
    private onAfterHunkAction?: () => Promise<void>
  ) {
    // autoRevealPanel is a user-level VS Code setting, so it can change at any time
    // (settings UI, settings.json, or the checkbox in our own settings screen).
    context.subscriptions.push(
      vscode.extensions.onDidChange(() => { this.returnOptionsCache = undefined; }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('hunktracker')) return;
        if (e.affectsConfiguration('hunktracker.autoRevealPanel')) {
          // Treat whatever is pending right now as already seen
          this.knownPending = undefined;
        }
        this.refresh(); // keeps the checkboxes in our settings screen in sync
      })
    );
  }

  /** User-level `hunktracker.autoRevealPanel` setting (applies to every project). */
  private get autoRevealPanel(): boolean {
    return getUserSetting('autoRevealPanel');
  }

  /** Dropdown entries; a saved value that no installed pane offers any more stays listed so it can be changed. */
  private returnViewOptions(selected: string): ReturnOption[] {
    this.returnOptionsCache ??= collectReturnOptions(
      vscode.extensions.all.map(e => e.packageJSON),
      'hunktrackerPanel'
    );
    if (!selected || this.returnOptionsCache.some(o => o.id === selected)) return this.returnOptionsCache;
    return [...this.returnOptionsCache, {
      id: selected,
      label: `${selected} (not found)`,
      info: 'No installed extension or built-in pane offers this command any more.',
    }];
  }

  private async saveReturnToView(value: string): Promise<void> {
    log(`settings: hunktracker.returnToView=${value || '(none)'} (user setting)`);
    try {
      await setReturnToView(value);
    } catch (err) {
      log(`returnToView: saving the user setting failed: ${err}`);
      this.refresh();
    }
  }

  private async saveUserSetting(key: UserSettingKey, value: boolean): Promise<void> {
    log(`settings: hunktracker.${key}=${value} (user setting)`);
    try {
      // The change listener in the constructor refreshes the panel.
      await setUserSetting(key, value);
    } catch (err) {
      log(`${key}: saving the user setting failed: ${err}`);
      this.refresh(); // put the checkbox back to the real value
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    // Shown as small grey text beside the view title.
    webviewView.description = `v${this.context.extension.packageJSON.version}`;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'ready') {
        if (this._loading) {
          this.view?.webview.postMessage({ type: 'loading', loading: true });
        } else {
          this.refresh();
        }
        return;
      }
      if (msg.command === 'visibilityPong') {
        this.visibilityPings.get(msg.id)?.(msg.shown === true);
        return;
      }
      this.handleMessage(msg);
    });
  }

  /**
   * Is the pane still on screen? `WebviewView.visible` stays true after a hide, so ask
   * the webview itself: a hidden webview has no viewport, or never answers. Only a
   * positive "yes" within the timeout counts as shown.
   */
  private isPaneShown(): Promise<boolean> {
    const view = this.view;
    if (!view) return Promise.resolve(false);
    return new Promise(resolve => {
      const id = ++this.nextPingId;
      const done = (shown: boolean) => {
        clearTimeout(timer);
        this.visibilityPings.delete(id);
        resolve(shown);
      };
      const timer = setTimeout(() => done(false), 500);
      this.visibilityPings.set(id, done);
      void Promise.resolve(view.webview.postMessage({ type: 'visibilityPing', id }))
        .catch(() => done(false));
    });
  }

  /**
   * Hide the hunktracker pane, then open the pane the user chose to return to. If the
   * pane is still shown afterwards (VS Code refuses to hide a lone view), do nothing.
   */
  private async hideAndReturn(): Promise<void> {
    try {
      await vscode.commands.executeCommand('hunktrackerToolbar.removeView');
    } catch (err) {
      log(`autoRevealPanel: hide failed: ${err}`);
      return;
    }
    const target = getReturnToView();
    if (!target) return;
    await new Promise(r => setTimeout(r, 150)); // let VS Code apply the hide
    if (await this.isPaneShown()) {
      log('autoRevealPanel: pane still shown after hide, not returning to the previous view');
      return;
    }
    log(`autoRevealPanel: returning to ${target}`);
    try {
      await vscode.commands.executeCommand(target);
    } catch (err) {
      log(`autoRevealPanel: returning to ${target} failed: ${err}`);
    }
  }

  refresh(): void {
    if (this._loading) return;
    // Without a resolved view there is nothing to update, but auto-reveal still
    // needs to notice new changes so it can open the panel for the first time.
    if (!this.view && !this.autoRevealPanel) return;
    const state = this.buildPanelState();
    this.view?.webview.postMessage({ type: 'update', state });
    this.revealOnNewChanges(state);
  }

  /**
   * autoRevealPanel: when a file newly enters the pending list and the panel is
   * not visible, bring it up without taking keyboard focus; when the last pending
   * file is gone, hide the hunktracker pane again (only that pane: other views in
   * the same side bar stay). Who opened or collapsed it is deliberately ignored.
   * VS Code has no API to collapse a single pane, so "hide" is the closest;
   * `<viewId>.removeView` is the per-view command behind the pane's "Hide" menu
   * item, and it is a no-op if hunktracker is the only view in its container.
   * The first state seen (e.g. changes restored from the last session) only
   * primes the baseline.
   */
  private revealOnNewChanges(state: PanelState): void {
    const current = new Set(state.files.map(f => f.filePath));
    const previous = this.knownPending;
    this.knownPending = current;
    if (!previous || !state.enabled || !this.autoRevealPanel) return;

    if (current.size === 0) {
      if (previous.size > 0) {
        log('autoRevealPanel: no pending changes left, hiding the hunktracker pane');
        void this.hideAndReturn();
      }
      return;
    }

    if (!Array.from(current).some(fp => !previous.has(fp))) return;
    // No `view.visible` check: after the pane is hidden (removeView) the flag stays
    // true, which made this return early and the pane never came back. Revealing an
    // already visible pane is harmless.
    log('autoRevealPanel: revealing panel for new pending changes');
    // WebviewView.show() does not bring back a view that was hidden (the close step
    // hides it), but the built-in focus command opens it, and its preserveFocus
    // option keeps the keyboard where it is. It also creates the view if it was
    // never resolved this session.
    void Promise.resolve(vscode.commands.executeCommand('hunktrackerToolbar.focus', { preserveFocus: true }))
      .catch(err => log(`autoRevealPanel: reveal failed: ${err}`));
  }

  setLoading(loading: boolean): void {
    this._loading = loading;
    if (!this.view) return;
    if (loading) {
      this.view.webview.postMessage({ type: 'loading', loading: true });
    } else {
      // Send the real state immediately so there's no flash of the disabled screen
      const state = this.buildPanelState();
      this.view.webview.postMessage({ type: 'update', state });
    }
  }

  openSettings(): void {
    if (!this.view) return;
    this.view.webview.postMessage({ type: 'openSettings' });
  }

  private buildPanelState(): PanelState {
    const files: PanelFile[] = [];
    let totalAdded = 0;
    let totalRemoved = 0;

    for (const [filePath, fileState] of this.stateManager.getAllFiles()) {
      if (fileState.status !== 'reviewing') continue;

      const fileExists = fs.existsSync(filePath);
      let currentContent: string;
      if (!fileExists) {
        currentContent = '';
      } else {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        currentContent = doc ? doc.getText() : '';
        if (!doc) {
          try { currentContent = fs.readFileSync(filePath, 'utf-8'); } catch { currentContent = ''; }
        }
      }

      const pendingHunks = computeHunks(fileState.baseline, currentContent);
      const isNew = fileState.baseline === null;
      const isDeleted = !fileExists && fileState.baseline !== null;
      // Show 0-hunk entries for new files (null baseline, e.g. new empty file)
      // and deleted files (file missing from disk) so accept/discard remain available.
      if (pendingHunks.length === 0 && !isNew && !isDeleted) continue;

      const totalLines = countLines(isDeleted ? (fileState.baseline ?? '') : currentContent);
      const addedLines = pendingHunks.reduce((s, h) => s + h.newLines, 0);
      const removedLines = pendingHunks.reduce((s, h) => s + h.oldLines, 0);
      totalAdded += addedLines;
      totalRemoved += removedLines;

      const workspaceFolders = vscode.workspace.workspaceFolders;
      const rootPath = workspaceFolders?.[0]?.uri.fsPath ?? '';
      const relPath = path.relative(rootPath, filePath);
      const fileName = path.basename(filePath);
      const dirName = path.dirname(relPath) === '.' ? '' : path.dirname(relPath);

      files.push({
        filePath,
        fileName,
        dirName,
        addedLines,
        removedLines,
        pendingCount: pendingHunks.length,
        totalLines,
        strip: computeStripMarks(pendingHunks, totalLines, isDeleted),
        isNew,
        isDeleted,
        hunks: pendingHunks.map(h => ({
          id: hunkId(h),
          filePath,
          newStart: h.newStart,
          newLines: h.newLines,
          oldLines: h.oldLines,
        })),
      });
    }

    // Same order as hunk navigation (see fileOrder.ts), so the prev/next arrows follow the list
    const sortedFiles = sortFiles(files, f => path.join(f.dirName, f.fileName));

    return {
      proposedApiStatus: this.proposedApiStatus,
      enabled: this.stateManager.enabled,
      ignorePatterns: this.stateManager.ignorePatterns,
      respectGitignore: this.stateManager.respectGitignore,
      clearOnBranchSwitch: this.stateManager.clearOnBranchSwitch,
      autoAcceptOnStartup: getUserSetting('autoAcceptOnStartup'),
      autoRevealPanel: this.autoRevealPanel,
      returnToView: getReturnToView(),
      returnViewOptions: this.returnViewOptions(getReturnToView()),
      useDiffEditor: this.stateManager.useDiffEditor,
      showInlineDecorations: this.stateManager.showInlineDecorations,
      totalFiles: sortedFiles.length,
      totalAdded,
      totalRemoved,
      files: sortedFiles,
    };
  }

  private async handleMessage(msg: {
    command: string;
    filePath?: string;
    hunkId?: string;
    folders?: string[];
    value?: boolean;
    text?: string;
  }): Promise<void> {
    switch (msg.command) {
      case 'openRuntimeArguments':
        await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
        break;
      case 'enable':
        await vscode.commands.executeCommand('hunktracker.enable');
        break;
      case 'disable':
        await vscode.commands.executeCommand('hunktracker.disable');
        break;
      case 'setIgnorePatterns':
        if (msg.folders !== undefined) {
          await vscode.commands.executeCommand('hunktracker.setIgnorePatterns', msg.folders);
        }
        break;
      case 'setRespectGitignore':
        if (msg.value !== undefined) {
          await vscode.commands.executeCommand('hunktracker.setRespectGitignore', msg.value);
        }
        break;
      case 'setClearOnBranchSwitch':
        if (msg.value !== undefined) {
          this.stateManager.setClearOnBranchSwitch(msg.value);
        }
        break;
      case 'setAutoAcceptOnStartup':
        if (msg.value !== undefined) await this.saveUserSetting('autoAcceptOnStartup', msg.value);
        break;
      case 'setAutoRevealPanel':
        if (msg.value !== undefined) await this.saveUserSetting('autoRevealPanel', msg.value);
        break;
      case 'setReturnToView':
        if (typeof msg.text === 'string') await this.saveReturnToView(msg.text);
        break;
      case 'focusReturnView': {
        const target = getReturnToView();
        if (!target) break;
        log(`settings: focusing ${target}`);
        try {
          await vscode.commands.executeCommand(target);
        } catch (err) {
          log(`focusing ${target} failed: ${err}`);
          void vscode.window.showWarningMessage(`Hunk Tracker: could not open the selected pane (${target}).`);
        }
        break;
      }
      case 'acceptAll':
        await acceptAllFiles(this.stateManager, this.onStateChanged);
        break;
      case 'discardAll':
        await discardAllFiles(this.stateManager, this.fileWatcher, this.onStateChanged);
        break;
      case 'acceptFile':
        if (msg.filePath) {
          acceptFileByPath(this.stateManager, msg.filePath, () => {
            this.onStateChanged();
            void this.onAfterHunkAction?.().catch(err => log(`onAfterHunkAction: ${err}`));
          });
        }
        break;
      case 'discardFile':
        if (msg.filePath) {
          await discardFileByPath(this.stateManager, this.fileWatcher, msg.filePath, () => {
            this.onStateChanged();
            void this.onAfterHunkAction?.().catch(err => log(`onAfterHunkAction: ${err}`));
          });
        }
        break;
      case 'acceptHunk':
        if (msg.filePath && msg.hunkId) {
          acceptHunk(this.stateManager, msg.filePath, msg.hunkId, () => {
            this.onStateChanged();
            this.onBaselineChanged?.(msg.filePath!);
            void this.onAfterHunkAction?.().catch(err => log(`onAfterHunkAction: ${err}`));
          }, 'panel');
        }
        break;
      case 'discardHunk':
        if (msg.filePath && msg.hunkId) {
          await discardHunk(this.stateManager, this.fileWatcher, msg.filePath, msg.hunkId, () => {
            this.onStateChanged();
            void this.onAfterHunkAction?.().catch(err => log(`onAfterHunkAction: ${err}`));
          }, 'panel');
        }
        break;
      case 'setUseDiffEditor':
        if (msg.value !== undefined) {
          this.stateManager.setUseDiffEditor(msg.value as boolean);
        }
        break;
      case 'setShowInlineDecorations':
        if (msg.value !== undefined) {
          this.stateManager.setShowInlineDecorations(msg.value as boolean);
          this.onStateChanged();
        }
        break;
      case 'openFile':
        if (msg.filePath) {
          log(`openFile(${path.basename(msg.filePath)}): opening in ${this.stateManager.useDiffEditor ? 'diffEditor' : 'normalEditor'}`);
          if (this.stateManager.useDiffEditor) {
            await this.openDiffEditor(msg.filePath);
          } else {
            const fileState = this.stateManager.getFile(msg.filePath);
            const doc = await vscode.window.showTextDocument(vscode.Uri.file(msg.filePath));
            if (fileState) {
              const hunks = computeHunks(fileState.baseline, doc.document.getText());
              if (hunks.length > 0) {
                const pos = new vscode.Position(Math.max(0, hunks[0].newStart - 1), 0);
                doc.selection = new vscode.Selection(pos, pos);
                doc.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
              }
            }
          }
        }
        break;
      case 'openDeletedDiff':
        if (msg.filePath) {
          const fileName = path.basename(msg.filePath);
          const baselineUri = vscode.Uri.file(msg.filePath).with({ scheme: 'hunktracker-baseline' });
          const emptyUri = vscode.Uri.from({ scheme: 'untitled', path: msg.filePath + '.deleted' });
          await vscode.commands.executeCommand('vscode.diff', baselineUri, emptyUri, `${fileName} (deleted)`);
        }
        break;
      case 'jumpToHunk':
        if (msg.filePath && msg.hunkId) {
          await this.openHunk(msg.filePath, msg.hunkId);
        }
        break;
    }
  }

  /** Open a file and move the cursor to one of its hunks (diff or normal editor, per settings). */
  async openHunk(filePath: string, targetHunkId: string): Promise<void> {
    log(`jumpToHunk(${path.basename(filePath)}): hunkId=${targetHunkId}, opening in ${this.stateManager.useDiffEditor ? 'diffEditor' : 'normalEditor'}`);
    if (this.stateManager.useDiffEditor) {
      await this.openDiffEditor(filePath, targetHunkId);
      return;
    }
    const fileState = this.stateManager.getFile(filePath);
    if (!fileState) return;
    const doc = await vscode.window.showTextDocument(vscode.Uri.file(filePath));
    const hunk = computeHunks(fileState.baseline, doc.document.getText())
      .find(h => hunkId(h) === targetHunkId);
    if (hunk) {
      const pos = new vscode.Position(Math.max(0, hunk.newStart - 1), 0);
      doc.selection = new vscode.Selection(pos, pos);
      doc.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  private async openDiffEditor(filePath: string, targetHunkId?: string): Promise<void> {
    const fileName = path.basename(filePath);
    const baselineUri = vscode.Uri.file(filePath).with({ scheme: 'hunktracker-baseline' });
    const currentUri = vscode.Uri.file(filePath);

    await vscode.commands.executeCommand('vscode.diff', baselineUri, currentUri, `${fileName} (Hunk Tracker)`);

    // Jump to the target hunk position in the diff editor's modified side.
    // Prefer the embedded editor (viewColumn undefined) over a normal editor for the same file.
    const fileState = this.stateManager.getFile(filePath);
    const candidates = vscode.window.visibleTextEditors.filter(
      e => e.document.uri.scheme === 'file' && e.document.uri.fsPath === filePath
    );
    const editor = candidates.find(e => e.viewColumn === undefined) ?? candidates[0];
    if (fileState && editor) {
      const hunks = computeHunks(fileState.baseline, editor.document.getText());
      const target = targetHunkId
        ? hunks.find(h => hunkId(h) === targetHunkId)
        : hunks[0];
      if (target) {
        const pos = new vscode.Position(Math.max(0, target.newStart - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaPath = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'panel.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'panel.js'));
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'logo.svg'));
    let html = fs.readFileSync(
      path.join(this.context.extensionUri.fsPath, 'media', 'panel.html'),
      'utf-8'
    );
    html = html.replace(/\{\{cssUri\}\}/g, cssUri.toString());
    html = html.replace(/\{\{logoUri\}\}/g, logoUri.toString());
    html = html.replace(/\{\{jsUri\}\}/g, jsUri.toString());
    html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
    return html;
  }
}
