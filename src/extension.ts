import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StateManager } from './stateManager';
import { FileWatcher } from './fileWatcher';
import { DecorationManager } from './decorationManager';
import { ReviewPanel } from './reviewPanel';
import { registerCommands, acceptHunk, discardHunk, acceptFileByPath } from './commands';
import { registerHunkNavigation } from './hunkNavigation';
import { DiffCodeLensProvider } from './diffCodeLens';
import { initLog, log } from './log';
import { probeProposedApi } from './proposedApi';
import { getUserSetting } from './userSettings';
import { sweepOrphanedStorage, describeSweep } from './storageCleanup';

export async function activate(context: vscode.ExtensionContext): Promise<{ getReviewPanel: () => ReviewPanel | undefined; getStateManager: () => StateManager | undefined; getFileWatcher: () => FileWatcher | undefined }> {
  initLog();
  const ext = vscode.extensions.getExtension('GeorgeSamartzidis.hunktracker');
  log(`activate v${ext?.packageJSON?.version ?? '?'}`);
  // Settings and baselines live in VS Code's per-workspace extension storage, not in the project.
  const dataDir = context.storageUri?.fsPath;
  log(`data dir: ${dataDir ?? '(none: no folder open)'}`);
  const stateManager = new StateManager(dataDir);
  stateManager.onRollback = () => onStateChanged();

  // Content provider for showing baselines in diff view
  const baselineChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  context.subscriptions.push(
    baselineChangeEmitter,
    vscode.workspace.registerTextDocumentContentProvider('hunktracker-baseline', {
      onDidChange: baselineChangeEmitter.event,
      provideTextDocumentContent(uri: vscode.Uri): string {
        const filePath = uri.fsPath;
        const fileState = stateManager.getFile(filePath);
        return fileState?.baseline ?? '';  // null baseline → '' for diff display
      },
    })
  );

  let decorationManager: DecorationManager | undefined;
  let reviewPanel: ReviewPanel | undefined;
  let diffCodeLensProvider: DiffCodeLensProvider | undefined;

  // Original state-changed callback — no diff-editor side effects
  function onStateChanged(): void {
    decorationManager?.refresh();
    reviewPanel?.refresh();
    diffCodeLensProvider?.fire();
  }

  /** Notify the diff editor that a specific file's baseline changed (only after accept). */
  function fireBaselineChange(filePath: string): void {
    baselineChangeEmitter.fire(vscode.Uri.file(filePath).with({ scheme: 'hunktracker-baseline' }));
  }

  /**
   * Close tabs for files that are no longer in reviewing state.
   * - Hunktracker diff tabs: always close; reopen normal editor if file still exists on disk
   * - Normal tabs for deleted files: close (new file was discarded)
   */
  async function closeStaleTabs(): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        // Hunktracker diff tab (normal file or deleted file)
        if (tab.input instanceof vscode.TabInputTextDiff
          && tab.input.original.scheme === 'hunktracker-baseline') {
          // For deleted files, modified is untitled:path.deleted; extract real path from original
          const filePath = tab.input.modified.scheme === 'file'
            ? tab.input.modified.fsPath
            : tab.input.original.fsPath;
          const fileState = stateManager.getFile(filePath);
          if (!fileState || fileState.status !== 'reviewing') {
            await vscode.window.tabGroups.close(tab);
            if (fs.existsSync(filePath)) {
              await vscode.window.showTextDocument(vscode.Uri.file(filePath));
            }
          }
          continue;
        }
        // Normal text tab for a deleted file that exited reviewing
        if (tab.input instanceof vscode.TabInputText) {
          const filePath = tab.input.uri.fsPath;
          if (tab.input.uri.scheme === 'file' && !fs.existsSync(filePath)) {
            const fileState = stateManager.getFile(filePath);
            if (!fileState || fileState.status !== 'reviewing') {
              await vscode.window.tabGroups.close(tab);
            }
          }
        }
      }
    }
  }

  let syncIgnore: () => void;
  const fileWatcher = new FileWatcher(stateManager, onStateChanged, () => syncIgnore());
  syncIgnore = () => stateManager.syncIgnoreState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir)).then(onStateChanged);
  // Register watcher early so gitignoreMatcher is initialized before load().
  // Suppress events during load to avoid race conditions where file changes
  // fire before state is fully restored from git.
  fileWatcher.register(context);
  fileWatcher.suppressAll();

  try {
    await stateManager.load((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
    log(`loaded state: enabled=${stateManager.enabled}, files=${stateManager.getAllFiles().size}`);
    if (stateManager.enabled && getUserSetting('autoAcceptOnStartup')) {
      const pending = Array.from(stateManager.getAllFiles().keys());
      for (const fp of pending) acceptFileByPath(stateManager, fp, () => {});
      if (pending.length > 0) {
        log(`autoAcceptOnStartup: accepted ${pending.length} pending file(s)`);
        vscode.window.setStatusBarMessage(`Hunk Tracker: auto-accepted ${pending.length} pending file(s) from the last session`, 8000);
      }
    }
  } finally {
    fileWatcher.resumeAll();
  }

  decorationManager = new DecorationManager(stateManager, (command, filePath, hId) => {
    if (command === 'prev' || command === 'next') {
      // Navigate relative to the clicked hunk (hunk ids start with its 1-based newStart line)
      const line = Number(hId.split(':')[0]);
      void vscode.commands.executeCommand(
        command === 'next' ? 'hunktracker.nextHunk' : 'hunktracker.prevHunk',
        { filePath, line: Number.isFinite(line) ? line : 1 }
      );
    } else if (command === 'accept') {
      acceptHunk(stateManager, filePath, hId, () => { onStateChanged(); fireBaselineChange(filePath); void closeStaleTabs().catch(err => log(`closeStaleTabs: ${err}`)); }, 'inset');
    } else {
      discardHunk(stateManager, fileWatcher, filePath, hId, () => { onStateChanged(); void closeStaleTabs().catch(err => log(`closeStaleTabs: ${err}`)); }, 'inset');
    }
  });

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(editors => {
      decorationManager?.refresh(editors);
      diffCodeLensProvider?.fire();
    }),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) decorationManager?.refresh([editor]);
      diffCodeLensProvider?.fire();
    }),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.scheme !== 'file') return;
      const editor = vscode.window.visibleTextEditors.find(
        ed => ed.document.uri.fsPath === e.document.uri.fsPath
      );
      if (editor) decorationManager?.refresh([editor]);
      reviewPanel?.refresh();
    }),
  );

  reviewPanel = new ReviewPanel(context, stateManager, fileWatcher, onStateChanged, fireBaselineChange, closeStaleTabs);
  // The inline hunk controls need the editorInsets proposal, which VS Code only allows
  // after an argv.json opt-in. If it is blocked, the panel shows setup steps instead.
  const createInset = (vscode.window as any).createWebviewTextEditorInset;
  const proposedApiStatus = probeProposedApi(
    typeof createInset === 'function' ? () => createInset.call(vscode.window, undefined, 0, 0) : undefined
  );
  log(`editorInsets proposed API: ${proposedApiStatus}`);
  reviewPanel.setProposedApiStatus(proposedApiStatus);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('hunktrackerToolbar', reviewPanel)
  );

  registerCommands(context, stateManager, fileWatcher, reviewPanel, onStateChanged);
  registerHunkNavigation(context, stateManager, reviewPanel);

  // ── Diff CodeLens ─────────────────────────────────────────────────────────
  diffCodeLensProvider = new DiffCodeLensProvider(stateManager);
  context.subscriptions.push(
    diffCodeLensProvider,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, diffCodeLensProvider),
    vscode.commands.registerCommand('hunktracker.codeLensAcceptHunk', (filePath: string, hId: string) => {
      acceptHunk(stateManager, filePath, hId, () => { onStateChanged(); fireBaselineChange(filePath); void closeStaleTabs().catch(err => log(`closeStaleTabs: ${err}`)); }, 'codeLens');
    }),
    vscode.commands.registerCommand('hunktracker.codeLensDiscardHunk', (filePath: string, hId: string) => {
      discardHunk(stateManager, fileWatcher, filePath, hId, () => { onStateChanged(); void closeStaleTabs().catch(err => log(`closeStaleTabs: ${err}`)); }, 'codeLens');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hunktracker.openSettings', () => {
      reviewPanel?.openSettings();
    }),
    vscode.commands.registerCommand('hunktracker.openGitHub', () => {
      void vscode.env.openExternal(vscode.Uri.parse('https://github.com/samartzidis/hunktracker'));
    }),
    vscode.commands.registerCommand('hunktracker.refresh', async () => {
      if (!stateManager.enabled) return;
      reviewPanel?.setLoading(true);
      try {
        await stateManager.rebuildState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
        onStateChanged();
      } catch (err) {
        log(`refresh: error — ${err}`);
      } finally {
        reviewPanel?.setLoading(false);
      }
    })
  );

  // Sync ignore state on startup in case .gitignore or ignorePatterns
  // changed while VSCode was closed. Show loading state during sync so
  // the panel doesn't flash stale data before the sync completes.
  if (stateManager.enabled) {
    reviewPanel.setLoading(true);
    log('startup sync: begin');
    Promise.all([
      new Promise(resolve => setTimeout(resolve, 750)),
      stateManager.syncIgnoreState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir)),
    ]).then(() => {
      log('startup sync: complete');
      reviewPanel?.setLoading(false);
      onStateChanged();
    }).catch((err) => {
      log(`startup sync: error — ${err}`);
      reviewPanel?.setLoading(false);
      onStateChanged();
    });
  } else {
    onStateChanged();
  }

  // ── Watch <data dir>/git/ for deletion ─────────────────────────────────────────
  // Detects: git dir deleted → reset to disabled; settings.json changed → reload patterns.
  const hunktrackerDir = stateManager.dir;
  if (hunktrackerDir) {
    const gitDir = path.join(hunktrackerDir, 'git');
    let settingsWatcher: fs.FSWatcher | undefined;

    const startSettingsWatch = () => {
      if (!fs.existsSync(hunktrackerDir)) return;
      try {
        settingsWatcher = fs.watch(hunktrackerDir, { persistent: false }, (_eventType, filename) => {
          if (filename === 'settings.json') {
            stateManager.reloadIgnorePatterns();
            syncIgnore();
          }
        });
      } catch (err) { log(`settings watch failed: ${err}`); }
    };

    // Poll for git dir existence — detect external deletion
    const pollInterval = setInterval(() => {
      const gitExists = fs.existsSync(gitDir);
      if (!stateManager.enabled && settingsWatcher) {
        // Disabled: release the directory handle. On Windows an open watcher keeps a deleted
        // data dir "delete pending", so re-creating it (next Enable) fails with EPERM.
        settingsWatcher.close();
        settingsWatcher = undefined;
      }
      if (!gitExists && stateManager.enabled) {
        log('git dir deleted externally — resetting to disabled');
        settingsWatcher?.close();
        settingsWatcher = undefined;
        stateManager.resetToDisabled();
        onStateChanged();
      } else if (gitExists && stateManager.enabled && !settingsWatcher) {
        startSettingsWatch();
      }
    }, 250);

    startSettingsWatch();

    context.subscriptions.push({
      dispose: () => {
        clearInterval(pollInterval);
        settingsWatcher?.close();
      },
    });
  }

  // ── Remove data left behind by deleted projects ─────────────────────────────
  // VS Code does not delete per-workspace extension storage when a project folder goes away.
  // Shortly after startup (off the critical path) remove our own folder for every project whose
  // local folder no longer exists. Other extensions' data and the current project are never touched.
  // Every sweep logs one summary line (even when nothing was found) and one line per failure.
  if (dataDir) {
    const sweepTimer = setTimeout(() => {
      sweepOrphanedStorage(dataDir)
        .then(r => { for (const line of describeSweep(r)) log(line); })
        .catch(err => log(`storage sweep failed: ${err}`));
    }, 30_000);
    context.subscriptions.push({ dispose: () => clearTimeout(sweepTimer) });
  }

  // ── Watch .git/HEAD for branch switches ─────────────────────────────────────
  // When clearOnBranchSwitch is enabled, suppress FileWatcher during the switch
  // so that file create/delete/change events caused by git checkout don't produce
  // false reviewing entries, then re-sync all baselines to the new branch content.
  //
  // On macOS, git checkout replaces .git/HEAD via atomic rename, which can
  // invalidate fs.watch. We recreate the watcher after every event.
  //
  // No extra delay is needed after clearHunksOnBranchSwitch completes: the
  // re-sync updates all baselines to match current disk content, so any late
  // FSEvents that arrive after resumeAll() will compare disk vs baseline,
  // find 0 hunks, and be harmless no-ops.
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    const gitHeadPath = path.join(workspaceRoot, '.git', 'HEAD');
    let lastHead: string | undefined;
    try { lastHead = fs.readFileSync(gitHeadPath, 'utf-8').trim(); } catch { /* no .git */ }

    if (lastHead !== undefined) {
      let headWatcher: fs.FSWatcher | undefined;
      const startHeadWatch = () => {
        headWatcher?.close();
        headWatcher = undefined;
        try {
          headWatcher = fs.watch(gitHeadPath, { persistent: false }, () => {
            // Recreate watcher immediately — on macOS, git checkout replaces
            // .git/HEAD via atomic rename, which can invalidate fs.watch.
            startHeadWatch();

            if (!stateManager.enabled || !stateManager.clearOnBranchSwitch) return;
            let currentHead: string | undefined;
            try { currentHead = fs.readFileSync(gitHeadPath, 'utf-8').trim(); } catch { return; }
            if (currentHead !== lastHead) {
              lastHead = currentHead;
              log(`branch switched → suppressing file watcher and clearing hunks`);
              fileWatcher.suppressAll();
              stateManager.clearHunksOnBranchSwitch(
                (fp, isDir) => fileWatcher.shouldIgnore(fp, isDir)
              ).then(() => {
                fileWatcher.resumeAll();
                onStateChanged();
              }).catch((err) => {
                log(`clearHunksOnBranchSwitch error: ${err}`);
                fileWatcher.resumeAll();
                onStateChanged();
              });
            }
          });
        } catch (err) { log(`HEAD watch failed: ${err}`); }
      };
      startHeadWatch();
      context.subscriptions.push({ dispose: () => headWatcher?.close() });
    }
  }

  context.subscriptions.push({
    dispose: () => { decorationManager?.dispose(); },
  });

  activeStateManager = stateManager;
  activeReviewPanel = reviewPanel;
  activeFileWatcher = fileWatcher;

  return { getReviewPanel, getStateManager, getFileWatcher };
}

let activeStateManager: StateManager | undefined;
let activeReviewPanel: ReviewPanel | undefined;
let activeFileWatcher: FileWatcher | undefined;

/** Exposed for integration tests */
export function getReviewPanel(): ReviewPanel | undefined {
  return activeReviewPanel;
}

/** Exposed for integration tests */
export function getStateManager(): StateManager | undefined {
  return activeStateManager;
}

/** Exposed for integration tests */
export function getFileWatcher(): FileWatcher | undefined {
  return activeFileWatcher;
}

export async function deactivate(): Promise<void> {
  log('deactivate');
  await activeStateManager?.flush();
}
