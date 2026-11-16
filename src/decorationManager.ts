import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { computeHunks, hunkId } from './diffEngine';
import { log } from './log';

// ── Added lines ──────────────────────────────────────────────────────────────
const addedLineDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
  isWholeLine: true,
});

// ── HTML helpers ─────────────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Deleted-lines insets ──────────────────────────────────────────────────────
// A single removed line is shown as is. Longer blocks are collapsed by default under a 1-line tree-style header
// ("› N removed lines"): an inset is a webview, which swallows mouse-wheel events,
// so a tall one gets in the way of scrolling the editor. The header and the lines are two
// insets. Toggling never replaces the header's webview (its chevron flips via a
// message), only the lines inset below it is created or removed: a new webview
// under the pointer shows no hand cursor until the mouse moves.

/** Key for a removed block's expanded state: its text, so edits elsewhere keep it. */
function removedBlockKey(filePath: string, removed: string[]): string {
  return crypto.createHash('sha1').update(filePath).update('\0').update(removed.join('\n')).digest('hex').slice(0, 16);
}

// Codicons chevron-right / chevron-down (16x16), as VS Code's tree twisties draw them.
const CHEVRON_RIGHT = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z"/></svg>';
const CHEVRON_DOWN = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"/></svg>';

/** Shared head of both removed-lines insets; only the header runs a script. */
const removedHead = (script: boolean): string => `<!DOCTYPE html><html style="background:var(--vscode-diffEditor-removedLineBackground,rgba(255,0,0,0.1))"><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';${script ? " script-src 'unsafe-inline';" : ''}">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; }
body {
  background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.1));
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
}`;

/** The removed lines themselves (shown only while expanded); `lines.length` editor lines tall. */
function buildRemovedLinesHtml(lines: string[], tabSize: number): string {
  const rows = lines.map(l => `<div class="line">${escapeHtml(l)}</div>`).join('');
  return `${removedHead(false)}
.line {
  white-space: pre; overflow: hidden; text-overflow: ellipsis; tab-size: ${tabSize};
  height: calc(100vh / ${lines.length}); line-height: calc(100vh / ${lines.length});
}
</style>
</head><body>${rows}</body></html>`;
}

/** The 1-line header; its state changes by a `{type:'expanded'}` message, not by new html. */
function buildRemovedHeaderHtml(count: number, key: string, expanded: boolean): string {
  const summary = `${count} removed line${count === 1 ? '' : 's'}`;
  return `${removedHead(true)}
button {
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: none; border-radius: 3px;
  color: var(--vscode-icon-foreground, var(--vscode-editor-foreground));
  cursor: pointer; user-select: none;
}
button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31)); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
button svg { width: 16px; height: 16px; flex: none; }
.row { height: 100vh; display: flex; align-items: center; }
.summary {
  height: 100%; max-height: 22px; gap: 2px; padding: 0 6px 0 0;
  color: var(--vscode-descriptionForeground, var(--vscode-editor-foreground));
  font-family: var(--vscode-font-family, sans-serif);
  font-size: 12px; white-space: nowrap;
}
.summary:hover { color: var(--vscode-foreground, var(--vscode-editor-foreground)); }
.summary .down { display: none; }
.expanded .summary .down { display: block; }
.expanded .summary .right { display: none; }
</style>
</head><body class="${expanded ? 'expanded' : ''}"><div class="row">`
    + `<button class="summary" title="${expanded ? 'Hide' : 'Show'} removed lines" onclick="toggle()">`
    + CHEVRON_RIGHT.replace('<svg ', '<svg class="right" ')
    + CHEVRON_DOWN.replace('<svg ', '<svg class="down" ')
    + `<span>${summary}</span></button></div><script>
const vscode = acquireVsCodeApi();
function toggle() { vscode.postMessage({ command: 'toggleRemoved', key: ${JSON.stringify(key)} }); }
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.type !== 'expanded') return;
  document.body.classList.toggle('expanded', !!m.value);
  document.querySelector('.summary').title = (m.value ? 'Hide' : 'Show') + ' removed lines';
});
</script></body></html>`;
}

// ── Action-bar inset ──────────────────────────────────────────────────────────

function buildActionsHtml(filePath: string, hunkId: string): string {
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: visible; }
body { background: transparent; position: relative; }
.bar {
  position: absolute;
  top: 3px; left: 4px;
  display: flex; align-items: center; gap: 4px;
}
button {
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #cccccc);
  border: 1px solid var(--vscode-button-border, rgba(128,128,128,0.4));
  border-radius: 2px;
  padding: 0 6px; font-size: 10px;
  font-family: var(--vscode-font-family, sans-serif);
  cursor: pointer; height: 20px; line-height: 1;
  display: inline-flex; align-items: center; white-space: nowrap;
}
button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.btn-accept {
  background: #2a7d3a;
  color: #d4f0da;
  border-color: rgba(63,185,80,0.3);
}
.btn-accept:hover { background: #256b31; }
.btn-discard {
  background: rgba(248,81,73,0.08);
  color: #c97d7a;
  border-color: rgba(248,81,73,0.25);
}
.btn-discard:hover { background: rgba(248,81,73,0.15); }
.btn-nav {
  width: 22px; padding: 0; justify-content: center;
  background: transparent;
  border-color: rgba(128,128,128,0.35);
}
.btn-nav:hover { background: rgba(128,128,128,0.2); }
.btn-nav svg { width: 12px; height: 12px; display: block; }
</style>
</head><body>
<div class="bar">
<button class="btn-nav" title="Previous hunk" onclick="nav('prev')"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 L5 8 L10 13"/></svg></button>
<button class="btn-accept" onclick="accept()">✓ Accept</button>
<button class="btn-discard" onclick="discard()">↺ Discard</button>
<button class="btn-nav" title="Next hunk" onclick="nav('next')"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3 L11 8 L6 13"/></svg></button>
</div>
<script>
const vscode = acquireVsCodeApi();
function accept() { vscode.postMessage({ command: 'accept', filePath: ${JSON.stringify(filePath)}, hunkId: ${JSON.stringify(hunkId)} }); }
function discard() { vscode.postMessage({ command: 'discard', filePath: ${JSON.stringify(filePath)}, hunkId: ${JSON.stringify(hunkId)} }); }
function nav(command) { vscode.postMessage({ command, filePath: ${JSON.stringify(filePath)}, hunkId: ${JSON.stringify(hunkId)} }); }
</script>
</body></html>`;
}

export type HunkAction = 'accept' | 'discard' | 'prev' | 'next';

interface HunkInset {
  inset: vscode.WebviewEditorInset;
  disposable: vscode.Disposable;
  disposeListener: vscode.Disposable;
  // Cache key (kind, position, height): used to detect whether this inset can be reused
  cacheKey: string;
  // What its html shows; a reused inset is reloaded only when this changes
  identity: string;
  disposed: boolean;
}

function insetCacheKey(kind: string, afterLine: number, height: number): string {
  return `${kind}:${afterLine}:${height}`;
}

export class DecorationManager {
  // editorKey → ordered list of insets for that editor
  private insets: Map<string, HunkInset[]> = new Map();
  private onAction: ((command: HunkAction, filePath: string, hunkId: string) => void) | undefined;
  // filePath → keys of removed-lines blocks the user expanded (collapsed by default)
  private expanded: Map<string, Set<string>> = new Map();

  constructor(
    private stateManager: StateManager,
    onAction?: (command: HunkAction, filePath: string, hunkId: string) => void,
  ) {
    this.onAction = onAction;
  }

  refresh(editors?: readonly vscode.TextEditor[]): void {
    const targets = editors ?? vscode.window.visibleTextEditors;
    const diffPaths = this.diffEditorFilePaths();
    for (const editor of targets) {
      this.applyToEditor(editor, diffPaths);
    }
  }

  refreshActionBar(_editor: vscode.TextEditor): void { /* buttons live in insets */ }

  private disposeInsetList(list: HunkInset[]): void {
    for (const h of list) {
      h.disposeListener.dispose();
      h.disposable.dispose();
      if (!h.disposed) h.inset.dispose();
    }
  }

  /**
   * Collect file paths that are open in any diff tab (git, hunktracker, etc.).
   */
  private diffEditorFilePaths(): Set<string> {
    const paths = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          paths.add(tab.input.modified.fsPath);
        }
      }
    }
    return paths;
  }

  private applyToEditor(editor: vscode.TextEditor, diffPaths: Set<string>): void {
    const filePath = editor.document.uri.fsPath;
    const editorKey = editor.document.uri.toString();
    const fileState = this.stateManager.getFile(filePath);

    // Skip insets: in diff editors (viewColumn undefined), or when user disabled inline decorations
    const isInDiff = editor.viewColumn === undefined && diffPaths.has(filePath);
    const skipInsets = isInDiff || !this.stateManager.showInlineDecorations;

    if (!fileState || fileState.status !== 'reviewing' || skipInsets) {
      if (!fileState || fileState.status !== 'reviewing') this.expanded.delete(filePath);
      this.disposeInsetList(this.insets.get(editorKey) ?? []);
      this.insets.delete(editorKey);
      editor.setDecorations(addedLineDecoration, []);
      return;
    }

    const addedRanges: vscode.Range[] = [];
    const tabSize = editor.options.tabSize as number || 4;
    const parsed = computeHunks(fileState.baseline, editor.document.getText());

    // Build the desired inset specs first
    interface InsetSpec {
      kind: 'header' | 'lines' | 'actions';
      afterLine: number;
      height: number;
      html: string;
      // A reused inset gets new html (a reload) only when this differs
      identity: string;
      // Posted to a reused inset instead (state the html does not need to carry)
      post?: unknown;
    }
    const specs: InsetSpec[] = [];
    const expandedHere = this.expanded.get(filePath);
    const liveKeys = new Set<string>();

    for (const hunk of parsed) {
      const id = hunkId(hunk);


      for (let i = 0; i < hunk.newLines; i++) {
        const lineIdx = hunk.newStart - 1 + i;
        if (lineIdx < editor.document.lineCount) {
          addedRanges.push(editor.document.lineAt(lineIdx).range);
        }
      }

      // ── Inset placement strategy ──
      //
      // Layout order (top → bottom):
      //   [deleted inset]   red lines showing removed content
      //   [green lines]     added lines in the actual document
      //   [action bar]      Accept / Discard buttons
      //
      // ── afterLine semantics ──
      // createWebviewTextEditorInset takes a 0-based line number.
      // Internally VSCode does +1 before storing as afterLineNumber (1-based).
      // afterLineNumber=0 means "above line 1" (file top).
      // So to place an inset above line 1 we must pass afterLine = -1.
      //
      // Normal case (newLines > 0):
      //   deleted → afterLine = newStart - 2  (just above the green block)
      //   action  → afterLine = newStart + newLines - 2  (just below the green block)
      //   Different afterLines, so push order doesn't matter.
      //
      // Pure deletion (newLines == 0):
      //   Both deleted and action use afterLine = newStart - 2 (same value).
      //   VSCode stacks insets at the same afterLine with the FIRST-pushed on TOP.
      //   So we push deleted first, then action, to render deleted above action.

      const hasDeletion = hunk.removedContent.length > 0;
      const hasAddition = hunk.newLines > 0;

      // afterLine for deleted inset: just above the green block (or above its insertion point)
      const deletedAfterLine = hunk.newStart - 2; // may be -1 when newStart==1, that's correct

      let actionAfterLine: number;
      if (hasAddition) {
        actionAfterLine = hunk.newStart + hunk.newLines - 2;
      } else {
        // Pure deletion: no green block. Action bar shares the same afterLine as the
        // deleted inset. VSCode stacks insets at the same afterLine with the first-pushed
        // on top, so we rely on push order below to place deleted above action.
        actionAfterLine = deletedAfterLine;
      }

      // When multiple insets share the same afterLine, VSCode stacks them so that
      // the FIRST pushed inset appears TOPMOST.  For the normal case (deletion above
      // green lines, action below), they have different afterLines so push order
      // doesn't matter.  For pure deletion (same afterLine), we push deleted first,
      // then action, so deleted renders above action.

      if (hasDeletion && hunk.removedContent.length === 1) {
        // One line is as tall as the header: show it directly, nothing to collapse
        const html = buildRemovedLinesHtml(hunk.removedContent, tabSize);
        specs.push({ kind: 'lines', afterLine: Math.max(-1, deletedAfterLine), height: 1, html, identity: html });
      } else if (hasDeletion) {
        const key = removedBlockKey(filePath, hunk.removedContent);
        const expanded = expandedHere?.has(key) ?? false;
        if (expanded) liveKeys.add(key);
        const afterLine = Math.max(-1, deletedAfterLine);
        const count = hunk.removedContent.length;
        specs.push({
          kind: 'header', afterLine, height: 1,
          html: buildRemovedHeaderHtml(count, key, expanded),
          identity: `${count}:${key}`,
          post: { type: 'expanded', value: expanded },
        });
        if (expanded) {
          const html = buildRemovedLinesHtml(hunk.removedContent, tabSize);
          specs.push({ kind: 'lines', afterLine, height: count, html, identity: html });
        }
      }
      const actionsHtml = buildActionsHtml(filePath, id);
      specs.push({
        kind: 'actions', afterLine: actionAfterLine, height: 2,
        html: actionsHtml, identity: actionsHtml,
      });
    }

    // Forget expanded blocks that no longer exist (accepted, discarded, edited away)
    if (expandedHere) {
      if (liveKeys.size > 0) this.expanded.set(filePath, liveKeys);
      else this.expanded.delete(filePath);
    }

    // Reuse existing insets with the same kind, position and height (matched by key,
    // not by list position, so expanding one block does not rebuild the insets after
    // it). A reused inset keeps its webview: html is replaced only when its identity
    // changed, otherwise the spec's message is posted. Insets on one afterLine stack
    // in creation order, so once one is created there, the rest of that afterLine
    // group is created anew too, below it.
    const reusable = new Map<string, HunkInset[]>();
    const leftovers = new Set<HunkInset>();
    for (const h of this.insets.get(editorKey) ?? []) {
      leftovers.add(h);
      if (h.disposed) continue;
      const list = reusable.get(h.cacheKey);
      if (list) list.push(h); else reusable.set(h.cacheKey, [h]);
    }
    const nextInsets: HunkInset[] = [];
    let createdAt: number | undefined;

    for (const spec of specs) {
      const key = insetCacheKey(spec.kind, spec.afterLine, spec.height);
      const prev = createdAt === spec.afterLine ? undefined : reusable.get(key)?.shift();
      if (prev) {
        leftovers.delete(prev);
        if (prev.identity !== spec.identity) {
          prev.inset.webview.html = spec.html;
          prev.identity = spec.identity;
        } else if (spec.post !== undefined) {
          void prev.inset.webview.postMessage(spec.post);
        }
        nextInsets.push(prev);
      } else {
        const created = this.makeInset(editorKey, editor, spec.afterLine, spec.height, spec.html, key, spec.identity);
        if (created) nextInsets.push(created);
        createdAt = spec.afterLine;
      }
    }

    // Dispose leftover insets not reused
    this.disposeInsetList([...leftovers]);

    editor.setDecorations(addedLineDecoration, addedRanges);
    if (nextInsets.length > 0) {
      this.insets.set(editorKey, nextInsets);
    } else {
      this.insets.delete(editorKey);
    }
  }

  private makeInset(
    editorKey: string,
    editor: vscode.TextEditor,
    afterLine: number,
    height: number,
    html: string,
    cacheKey: string,
    identity: string,
  ): HunkInset | undefined {
    try {
      const inset = (vscode.window as any).createWebviewTextEditorInset(
        editor, afterLine, height, { enableScripts: true }
      ) as vscode.WebviewEditorInset;
      inset.webview.html = html;
      const disposable = inset.webview.onDidReceiveMessage((msg: any) => {
        if (msg.command === 'toggleRemoved' && typeof msg.key === 'string') {
          const filePath = editor.document.uri.fsPath;
          const set = this.expanded.get(filePath) ?? new Set<string>();
          if (set.has(msg.key)) set.delete(msg.key); else set.add(msg.key);
          if (set.size > 0) this.expanded.set(filePath, set); else this.expanded.delete(filePath);
          this.refresh();
        } else if (msg.command === 'accept' || msg.command === 'discard' || msg.command === 'prev' || msg.command === 'next') {
          this.onAction?.(msg.command, msg.filePath, msg.hunkId);
        }
      });
      const entry: HunkInset = {
        inset, disposable, cacheKey, identity, disposed: false,
        disposeListener: inset.onDidDispose(() => {
          entry.disposed = true;
          // Re-apply if editor is still visible so insets are immediately rebuilt
          const targetEditor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === editorKey
          );
          if (targetEditor) this.applyToEditor(targetEditor, this.diffEditorFilePaths());
        }),
      };
      return entry;
    } catch (err) {
      log(`createWebviewTextEditorInset failed: ${err}`);
      return undefined;
    }
  }

  dispose(): void {
    addedLineDecoration.dispose();
    for (const list of this.insets.values()) {
      this.disposeInsetList(list);
    }
    this.insets.clear();
  }
}
