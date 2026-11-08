// @ts-check
/** @type {{ postMessage: (msg: unknown) => void, getState: () => unknown, setState: (state: unknown) => void }} */
const vscode = /** @type {any} */ (globalThis).acquireVsCodeApi();
const app = document.getElementById('app');

/** @type {{ proposedApiStatus: 'available' | 'blocked' | 'missing', enabled: boolean, ignorePatterns: string[], globalIgnorePatterns: string[], respectGitignore: boolean, clearOnBranchSwitch: boolean, autoAcceptOnStartup: boolean, autoRevealPanel: boolean, returnToView: string, returnViewOptions: { id: string, label: string, info: string }[], useDiffEditor: boolean, showInlineDecorations: boolean, totalFiles: number, totalAdded: number, totalRemoved: number, files: any[] } | null} */
let currentState = null;
/** @type {Set<string>} */
const expandedFiles = new Set();
/** @type {'main' | 'settings'} */
let view = 'main';
/** Track whether we are currently in loading state, so the next update can fade in */
let isLoading = false;
/** The "Global scoped" checkbox next to the exclude pattern input; kept across re-renders */
let addGlobalPattern = false;

// Logo image (media/logo.svg), URI injected by reviewPanel.getHtml via <body data-logo>
const LOGO_URI = document.body.dataset.logo || '';

/**
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * @param {string} label
 * @param {string} cls
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function btn(label, cls, onClick) {
  const b = /** @type {HTMLButtonElement} */ (document.createElement('button'));
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return b;
}


/** @param {HTMLElement} parent */
function appendIcon(parent) {
  const wrap = el('div', 'splash-icon');
  const img = el('img');
  img.src = LOGO_URI;
  img.alt = '';
  img.width = 72;
  img.height = 72;
  img.draggable = false;
  wrap.appendChild(img);
  parent.appendChild(wrap);
}

/**
 * @param {{ proposedApiStatus: 'available' | 'blocked' | 'missing', enabled: boolean, ignorePatterns: string[], globalIgnorePatterns: string[], respectGitignore: boolean, clearOnBranchSwitch: boolean, autoAcceptOnStartup: boolean, autoRevealPanel: boolean, returnToView: string, returnViewOptions: { id: string, label: string, info: string }[], useDiffEditor: boolean, showInlineDecorations: boolean, totalFiles: number, totalAdded: number, totalRemoved: number, files: any[] }} state
 */
function render(state) {
  if (!app) return;
  app.innerHTML = '';

  // Strict comparisons: an unknown or absent status must never grey out a working pane.
  if (state.proposedApiStatus === 'blocked') {
    renderBlockedScreen();
    return;
  }
  if (state.proposedApiStatus === 'missing') {
    renderMissingApiScreen();
    return;
  }

  if (!state.enabled) {
    renderSetupScreen();
    return;
  }

  if (view === 'settings') {
    renderSettingsScreen(state);
    return;
  }

  if (state.totalFiles === 0) {
    renderIdleScreen();
    return;
  }

  renderReviewScreen(state);
}

/**
 * The editorInsets proposed API is blocked, so the inline hunk controls cannot
 * work. Grey the pane out and explain the one-time setup.
 */
function renderBlockedScreen() {
  if (!app) return;
  const screen = el('div', 'splash-screen splash-blocked');
  appendIcon(screen);
  screen.appendChild(el('p', 'blocked-title', 'Setup required'));
  screen.appendChild(el('p', 'splash-tagline',
    'Hunk Tracker needs a VS Code proposed API that is not enabled yet.'));

  const steps = el('ol', 'blocked-steps');
  const step1 = el('li');
  step1.append('Open ');
  step1.appendChild(el('code', '', 'argv.json'));
  step1.append(' (button below) and add the extension ID to ');
  step1.appendChild(el('code', '', 'enable-proposed-api'));
  step1.append(':');
  steps.appendChild(step1);
  const step2 = el('li');
  step2.appendChild(el('code', '', '"enable-proposed-api": ["GeorgeSamartzidis.hunktracker"]'));
  steps.appendChild(step2);
  steps.appendChild(el('li', '', 'Fully quit VS Code (not just the window) and reopen it.'));
  screen.appendChild(steps);

  screen.appendChild(btn('Open argv.json', 'btn-primary', () => {
    vscode.postMessage({ command: 'openRuntimeArguments' });
  }));
  app.appendChild(screen);
}

/** This VS Code version no longer provides the editorInsets API: nothing the user can enable. */
function renderMissingApiScreen() {
  if (!app) return;
  const screen = el('div', 'splash-screen splash-blocked');
  appendIcon(screen);
  screen.appendChild(el('p', 'blocked-title', 'Not supported by this VS Code version'));
  screen.appendChild(el('p', 'splash-tagline',
    'Hunk Tracker relies on the editorInsets proposed API, which this VS Code build no longer provides.'));
  app.appendChild(screen);
}

function renderSetupScreen() {
  if (!app) return;
  const screen = el('div', 'splash-screen');
  appendIcon(screen);
  screen.appendChild(btn('Enable for this project', 'btn-primary', () => {
    vscode.postMessage({ command: 'enable' });
  }));
  app.appendChild(screen);
}

function renderIdleScreen() {
  if (!app) return;
  const screen = el('div', 'splash-screen');
  appendIcon(screen);
  screen.appendChild(el('p', 'splash-tagline', 'No pending changes'));
  app.appendChild(screen);
}

/**
 * @param {{ ignorePatterns: string[], globalIgnorePatterns: string[], respectGitignore: boolean, clearOnBranchSwitch: boolean, autoAcceptOnStartup: boolean, autoRevealPanel: boolean, returnToView: string, returnViewOptions: { id: string, label: string, info: string }[], useDiffEditor: boolean, showInlineDecorations: boolean }} state
 */
function renderSettingsScreen(state) {
  if (!app) return;

  // Header with back button
  const header = el('div', 'settings-header');
  const backBtn = btn('← Back', 'btn-back', () => {
    view = 'main';
    if (currentState) render(currentState);
  });
  header.appendChild(backBtn);
  header.appendChild(el('span', 'settings-header-title', 'Settings'));
  app.appendChild(header);

  const body = el('div', 'settings-body');

  // ── Respect .gitignore ──
  const gitignoreSection = el('div', 'settings-section');
  gitignoreSection.appendChild(el('div', 'settings-section-title', 'Git Integration'));

  const checkRow = el('label', 'settings-check-row');
  checkRow.appendChild(el('span', 'settings-check-label', 'Respect .gitignore'));
  const checkDescRow = el('div', 'settings-check-desc-row');
  const checkbox = /** @type {HTMLInputElement} */ (document.createElement('input'));
  checkbox.type = 'checkbox';
  checkbox.className = 'settings-checkbox';
  checkbox.checked = state.respectGitignore;
  checkbox.addEventListener('change', () => {
    vscode.postMessage({ command: 'setRespectGitignore', value: checkbox.checked });
  });
  checkDescRow.appendChild(checkbox);
  checkDescRow.appendChild(el('span', 'settings-check-desc', 'Skip files already ignored by your project\'s .gitignore'));
  checkRow.appendChild(checkDescRow);
  gitignoreSection.appendChild(checkRow);

  // Clear on branch switch
  const branchRow = el('label', 'settings-check-row');
  branchRow.appendChild(el('span', 'settings-check-label', 'Clear hunks on branch switch'));
  const branchDescRow = el('div', 'settings-check-desc-row');
  const branchCheckbox = /** @type {HTMLInputElement} */ (document.createElement('input'));
  branchCheckbox.type = 'checkbox';
  branchCheckbox.className = 'settings-checkbox';
  branchCheckbox.checked = state.clearOnBranchSwitch;
  branchCheckbox.addEventListener('change', () => {
    vscode.postMessage({ command: 'setClearOnBranchSwitch', value: branchCheckbox.checked });
  });
  branchDescRow.appendChild(branchCheckbox);
  branchDescRow.appendChild(el('span', 'settings-check-desc', 'Automatically clear pending hunks when you switch branches'));
  branchRow.appendChild(branchDescRow);
  gitignoreSection.appendChild(branchRow);

  // ── Behavior (plugin-wide user settings) ──
  const behaviorSection = el('div', 'settings-section');
  behaviorSection.appendChild(el('div', 'settings-section-title', 'Behavior'));

  // Auto-accept pending hunks on startup
  const autoAcceptRow = el('label', 'settings-check-row');
  autoAcceptRow.appendChild(el('span', 'settings-check-label', 'Auto-accept pending hunks on startup'));
  const autoAcceptDescRow = el('div', 'settings-check-desc-row');
  const autoAcceptCheckbox = /** @type {HTMLInputElement} */ (document.createElement('input'));
  autoAcceptCheckbox.type = 'checkbox';
  autoAcceptCheckbox.className = 'settings-checkbox';
  autoAcceptCheckbox.checked = state.autoAcceptOnStartup;
  autoAcceptCheckbox.addEventListener('change', () => {
    vscode.postMessage({ command: 'setAutoAcceptOnStartup', value: autoAcceptCheckbox.checked });
  });
  autoAcceptDescRow.appendChild(autoAcceptCheckbox);
  autoAcceptDescRow.appendChild(el('span', 'settings-check-desc', 'When VS Code opens this workspace, accept all changes left pending from the last session instead of listing them'));
  autoAcceptRow.appendChild(autoAcceptDescRow);
  behaviorSection.appendChild(autoAcceptRow);

  // Auto-reveal the panel when new changes arrive
  const autoRevealRow = el('label', 'settings-check-row');
  autoRevealRow.appendChild(el('span', 'settings-check-label', 'Auto-reveal panel on new changes'));
  const autoRevealDescRow = el('div', 'settings-check-desc-row');
  const autoRevealCheckbox = /** @type {HTMLInputElement} */ (document.createElement('input'));
  autoRevealCheckbox.type = 'checkbox';
  autoRevealCheckbox.className = 'settings-checkbox';
  autoRevealCheckbox.checked = state.autoRevealPanel;
  autoRevealCheckbox.addEventListener('change', () => {
    vscode.postMessage({ command: 'setAutoRevealPanel', value: autoRevealCheckbox.checked });
  });
  autoRevealDescRow.appendChild(autoRevealCheckbox);
  autoRevealDescRow.appendChild(el('span', 'settings-check-desc', 'Applies to all projects (user setting). When a file gets new pending changes, bring this view up without taking keyboard focus, and hide it again when nothing is pending. Meant for a side-bar layout; in the bottom panel it would switch away from Terminal'));
  autoRevealRow.appendChild(autoRevealDescRow);
  behaviorSection.appendChild(autoRevealRow);

  // Pane to return to when auto-reveal hides hunktracker
  const returnRow = el('div', 'settings-check-row settings-select-row');
  returnRow.appendChild(el('span', 'settings-check-label', 'After auto-hide, return to'));
  const returnSelect = /** @type {HTMLSelectElement} */ (document.createElement('select'));
  returnSelect.className = 'settings-select';
  returnSelect.appendChild(new Option('None (do nothing)', ''));
  for (const o of state.returnViewOptions || []) {
    returnSelect.appendChild(new Option(o.label, o.id));
  }
  returnSelect.value = state.returnToView || '';
  const focusBtn = btn('Focus', 'btn-secondary', () => {
    vscode.postMessage({ command: 'focusReturnView' });
  });
  focusBtn.title = 'Open the selected pane now';
  focusBtn.disabled = !returnSelect.value;
  const returnInfo = el('div', 'settings-select-info');
  const showReturnInfo = () => {
    const option = (state.returnViewOptions || []).find(o => o.id === returnSelect.value);
    const text = option ? `${option.info}\nCommand: ${option.id}` : '';
    returnInfo.textContent = text;
    returnInfo.hidden = !text;
  };
  showReturnInfo();
  // Only used when auto-reveal is on, so the row is shown only while it is on
  const syncReturnEnabled = () => {
    returnRow.hidden = !autoRevealCheckbox.checked;
    focusBtn.disabled = !returnSelect.value;
  };
  autoRevealCheckbox.addEventListener('change', syncReturnEnabled);
  returnSelect.addEventListener('change', () => {
    syncReturnEnabled();
    showReturnInfo();
    vscode.postMessage({ command: 'setReturnToView', text: returnSelect.value });
  });
  const returnLine = el('div', 'settings-select-line');
  returnLine.appendChild(returnSelect);
  returnLine.appendChild(focusBtn);
  returnRow.appendChild(returnLine);
  returnRow.appendChild(returnInfo);
  returnRow.appendChild(el('span', 'settings-check-desc', 'Used with auto-reveal. When Hunk Tracker hides because nothing is pending, open this pane again. If Hunk Tracker could not hide (VS Code keeps a lone view open), nothing happens. Applies to all projects (user setting)'));
  syncReturnEnabled();
  behaviorSection.appendChild(returnRow);

  // ── Appearance ──
  const appearanceSection = el('div', 'settings-section');
  appearanceSection.appendChild(el('div', 'settings-section-title', 'Appearance'));

  // Show inline decorations
  const inlineDecRow = el('label', 'settings-check-row');
  inlineDecRow.appendChild(el('span', 'settings-check-label', 'Show inline decorations'));
  const inlineDecDescRow = el('div', 'settings-check-desc-row');
  const inlineDecCheckbox = /** @type {HTMLInputElement} */ (document.createElement('input'));
  inlineDecCheckbox.type = 'checkbox';
  inlineDecCheckbox.className = 'settings-checkbox';
  inlineDecCheckbox.checked = state.showInlineDecorations;
  inlineDecCheckbox.addEventListener('change', () => {
    vscode.postMessage({ command: 'setShowInlineDecorations', value: inlineDecCheckbox.checked });
  });
  inlineDecDescRow.appendChild(inlineDecCheckbox);
  inlineDecDescRow.appendChild(el('span', 'settings-check-desc', 'Show Accept/Discard buttons and diff highlights inline in the editor'));
  inlineDecRow.appendChild(inlineDecDescRow);
  appearanceSection.appendChild(inlineDecRow);

  // Open diff editor from panel
  const diffEditorRow = el('label', 'settings-check-row');
  diffEditorRow.appendChild(el('span', 'settings-check-label', 'Open diff editor from panel'));
  const diffEditorDescRow = el('div', 'settings-check-desc-row');
  const diffEditorCheckbox = /** @type {HTMLInputElement} */ (document.createElement('input'));
  diffEditorCheckbox.type = 'checkbox';
  diffEditorCheckbox.className = 'settings-checkbox';
  diffEditorCheckbox.checked = state.useDiffEditor;
  diffEditorCheckbox.addEventListener('change', () => {
    vscode.postMessage({ command: 'setUseDiffEditor', value: diffEditorCheckbox.checked });
  });
  diffEditorDescRow.appendChild(diffEditorCheckbox);
  diffEditorDescRow.appendChild(el('span', 'settings-check-desc', 'Clicking files or hunks in the panel opens a diff view (baseline vs current) instead of the inline editor'));
  diffEditorRow.appendChild(diffEditorDescRow);
  appearanceSection.appendChild(diffEditorRow);

  // ── Exclude Patterns ──
  const patternSection = el('div', 'settings-section');
  patternSection.appendChild(el('div', 'settings-section-title', 'Exclude Patterns'));
  patternSection.appendChild(el('p', 'settings-section-desc', 'gitignore-style patterns to exclude from change tracking (relative to workspace root). .git folders and files over 10 MB are always excluded. Global patterns apply to every project and are merged with this project\'s own.'));

  const patternList = el('div', 'pattern-list');
  const globalPatterns = state.globalIgnorePatterns || [];

  /**
   * @param {string} pattern
   * @param {boolean} isGlobal
   */
  const patternRow = (pattern, isGlobal) => {
    const inner = el('div', 'pattern-row-inner');
    inner.appendChild(el('span', 'pattern-text', pattern));
    if (isGlobal) {
      const tag = el('span', 'pattern-scope', 'global');
      tag.title = 'Applies to every project (user setting hunktracker.globalIgnorePatterns)';
      inner.appendChild(tag);
    }
    const delBtn = el('button', 'pattern-del', '');
    delBtn.title = isGlobal ? 'Remove from all projects' : 'Remove';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (isGlobal) {
        vscode.postMessage({ command: 'setGlobalIgnorePatterns', folders: globalPatterns.filter(f => f !== pattern) });
      } else {
        vscode.postMessage({ command: 'setIgnorePatterns', folders: state.ignorePatterns.filter(f => f !== pattern) });
      }
    });
    inner.appendChild(delBtn);
    return inner;
  };

  // Global first: that is also the order they are applied in, so a project line can re-include with "!"
  for (const pattern of globalPatterns) patternList.appendChild(patternRow(pattern, true));
  for (const pattern of state.ignorePatterns) patternList.appendChild(patternRow(pattern, false));

  const addRow = el('div', 'pattern-add-row');
  const addInput = /** @type {HTMLInputElement} */ (document.createElement('input'));
  addInput.type = 'text';
  addInput.className = 'pattern-input';
  addInput.placeholder = 'e.g. node_modules';
  const addBtn = el('button', 'pattern-add-btn', 'Add');
  addBtn.addEventListener('click', e => {
    e.stopPropagation();
    const val = addInput.value.trim();
    if (val) {
      if (addGlobalPattern) {
        if (!globalPatterns.includes(val)) {
          vscode.postMessage({ command: 'setGlobalIgnorePatterns', folders: [...globalPatterns, val] });
        }
      } else if (!state.ignorePatterns.includes(val)) {
        vscode.postMessage({ command: 'setIgnorePatterns', folders: [...state.ignorePatterns, val] });
      }
    }
    addInput.value = '';
  });
  addInput.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });
  addRow.appendChild(addInput);
  addRow.appendChild(addBtn);
  patternList.appendChild(addRow);

  const scopeRow = el('label', 'pattern-scope-row');
  scopeRow.title = 'Ticked: the next pattern you add applies to every project. Unticked: only to this project.';
  const scopeCheckbox = /** @type {HTMLInputElement} */ (document.createElement('input'));
  scopeCheckbox.type = 'checkbox';
  scopeCheckbox.className = 'settings-checkbox';
  scopeCheckbox.checked = addGlobalPattern;
  scopeCheckbox.addEventListener('change', () => { addGlobalPattern = scopeCheckbox.checked; });
  scopeRow.appendChild(scopeCheckbox);
  scopeRow.appendChild(el('span', 'settings-check-desc', 'Global scoped'));
  patternList.appendChild(scopeRow);
  patternSection.appendChild(patternList);
  body.appendChild(appearanceSection);
  body.appendChild(patternSection);
  body.appendChild(gitignoreSection);
  body.appendChild(behaviorSection);

  // ── Disable ──
  const disableSection = el('div', 'settings-section settings-section-danger');
  disableSection.appendChild(el('div', 'settings-section-title', 'Danger Zone'));
  disableSection.appendChild(el('p', 'settings-section-desc', 'Disables Hunk Tracker and clears all tracked state for this project.'));
  disableSection.appendChild(btn('Disable Hunk Tracker', 'btn-disable', () => {
    vscode.postMessage({ command: 'disable' });
  }));
  body.appendChild(disableSection);

  app.appendChild(body);
}

/**
 * File extension → background color for the badge
 * @param {string} fileName
 * @returns {string}
 */
function extColor(fileName) {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  /** @type {Record<string,string>} */
  const m = {
    ts:'#3178c6',tsx:'#3178c6',
    js:'#d4a017',jsx:'#d4a017',mjs:'#d4a017',
    json:'#d4a017',
    py:'#3572A5',
    go:'#00add8',
    rs:'#dea584',
    java:'#b07219',kt:'#a97bff',
    rb:'#cc342d',php:'#4f5d95',cs:'#178600',
    cpp:'#f34b7d',c:'#a8a8a8',h:'#a8a8a8',
    html:'#e34c26',htm:'#e34c26',
    css:'#563d7c',scss:'#c6538c',less:'#1d365d',
    md:'#4a90d9',mdx:'#4a90d9',
    yaml:'#cb171e',yml:'#cb171e',toml:'#9c4221',
    sh:'#89e051',bash:'#89e051',
    swift:'#F05138',vue:'#41b883',svelte:'#ff3e00',dart:'#00B4AB',
  };
  return m[ext] ?? '#6e7681';
}

/**
 * Create a small colored badge showing the file extension abbreviation
 * @param {string} fileName
 * @returns {HTMLElement}
 */
function fileIconBadge(fileName) {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  const abbr = ext.length <= 3 ? ext.toUpperCase() : ext.slice(0,3).toUpperCase();
  const badge = el('span', 'file-badge', abbr);
  badge.style.background = extColor(fileName);
  return badge;
}

/**
 * @param {{ enabled: boolean, ignorePatterns: string[], globalIgnorePatterns: string[], totalFiles: number, totalAdded: number, totalRemoved: number, files: any[] }} state
 */
function renderReviewScreen(state) {
  if (!app) return;

  // Summary header
  const header = el('div', 'review-header');
  const summary = el('div', 'review-summary');
  summary.appendChild(document.createTextNode(`${state.totalFiles} file${state.totalFiles > 1 ? 's' : ''} `));
  summary.appendChild(el('span', 'stat-added', `+${state.totalAdded}`));
  summary.appendChild(document.createTextNode(' '));
  summary.appendChild(el('span', 'stat-removed', `-${state.totalRemoved}`));
  const actions = el('div', 'review-actions');
  actions.appendChild(btn('✓ Accept', 'btn-review-accept', () => vscode.postMessage({ command: 'acceptAll' })));
  actions.appendChild(btn('↺ Discard', 'btn-review-discard', () => vscode.postMessage({ command: 'discardAll' })));
  header.appendChild(summary);
  header.appendChild(actions);
  app.appendChild(header);

  for (const file of state.files) {
    app.appendChild(renderFileGroup(file));
  }
}

/** Lines the active editor shows: { filePath, firstLine, lastLine } (0-based, inclusive) or null. */
let editorViewport = null;

/** Show or hide the viewport frame on one strip according to `editorViewport`. */
function placeViewport(strip) {
  const frame = strip.querySelector('.strip-viewport');
  if (!frame) return;
  const total = Number(strip.dataset.total);
  const vp = editorViewport;
  if (!vp || vp.filePath !== strip.dataset.path || !(total > 0) || vp.lastLine < vp.firstLine) {
    frame.hidden = true;
    return;
  }
  const clamp = x => Math.min(1, Math.max(0, x));
  const start = clamp(vp.firstLine / total);
  const end = Math.max(start, clamp((vp.lastLine + 1) / total));
  frame.style.left = `min(${(start * 100).toFixed(2)}%, calc(100% - 4px))`;
  frame.style.width = `${((end - start) * 100).toFixed(2)}%`;
  frame.hidden = false;
}

/**
 * Thin bar standing for the whole file, with a mark where each pending change sits.
 * Purely visual: the marks ignore the pointer, so a click on the strip is a click on the row.
 * @param {{ totalLines: number, pendingCount: number, strip: { start: number, end: number, kind: string }[], isNew: boolean, isDeleted: boolean }} file
 */
function changeStrip(file) {
  const strip = el('div', 'file-strip');
  for (const m of file.strip || []) {
    const mark = el('span', `strip-mark strip-${m.kind}`);
    // min() keeps a zero-width mark at the very end of the file inside the bar
    mark.style.left = `min(${(m.start * 100).toFixed(2)}%, calc(100% - 2px))`;
    mark.style.width = `${((m.end - m.start) * 100).toFixed(2)}%`;
    strip.appendChild(mark);
  }
  if (!file.isDeleted) {
    // Frame around the part of the file the active editor shows; moved by `viewport` messages
    // without a re-render, so it is also placed here for a freshly built strip
    strip.dataset.path = file.filePath;
    strip.dataset.total = String(file.totalLines);
    const frame = el('span', 'strip-viewport');
    frame.hidden = true;
    strip.appendChild(frame);
    placeViewport(strip);
  }
  const lines = file.totalLines === 1 ? '1 line' : `${file.totalLines} lines`;
  strip.title = file.isDeleted ? `Deleted file (${lines})`
    : file.isNew ? `New file (${lines})`
    : `${file.pendingCount} change${file.pendingCount === 1 ? '' : 's'} in ${lines}`;
  return strip;
}

/**
 * @param {{ filePath: string, fileName: string, dirName: string, addedLines: number, removedLines: number, pendingCount: number, totalLines: number, strip: { start: number, end: number, kind: string }[], isNew: boolean, isDeleted: boolean, hunks: any[] }} file
 */
function renderFileGroup(file) {
  const isSpecial = file.isNew || file.isDeleted;
  const isExpanded = !isSpecial && expandedFiles.has(file.filePath);
  const group = el('div', 'file-group');

  const fileRow = el('div', 'file-row');
  fileRow.addEventListener('click', () => {
    if (isSpecial) {
      if (file.isDeleted) {
        vscode.postMessage({ command: 'openDeletedDiff', filePath: file.filePath });
      } else {
        vscode.postMessage({ command: 'openFile', filePath: file.filePath });
      }
      return;
    }
    if (isExpanded) {
      expandedFiles.delete(file.filePath);
    } else {
      expandedFiles.add(file.filePath);
      if (file.hunks.length > 0) {
        vscode.postMessage({ command: 'jumpToHunk', filePath: file.filePath, hunkId: file.hunks[0].id });
      }
    }
    if (currentState) render(currentState);
  });

  const chevron = isSpecial ? el('span', 'file-chevron', '') : el('span', 'file-chevron', isExpanded ? '▼' : '▶');
  const fileIcon = fileIconBadge(file.fileName);
  const name = el('span', 'file-name', file.fileName);
  if (!isSpecial) {
    name.classList.add('file-name-link');
    name.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ command: 'openFile', filePath: file.filePath });
    });
  }
  const badge = file.isNew ? el('span', 'file-status-badge file-status-new', 'new')
    : file.isDeleted ? el('span', 'file-status-badge file-status-deleted', 'deleted')
    : null;
  const dir = file.dirName ? el('span', 'file-dir', file.dirName) : null;

  const right = el('div', 'file-right');
  const stats = el('div', 'file-stats');
  if (file.addedLines > 0) stats.appendChild(el('span', 'stat-added', `+${file.addedLines}`));
  if (file.addedLines > 0 && file.removedLines > 0) stats.appendChild(document.createTextNode(' '));
  if (file.removedLines > 0) stats.appendChild(el('span', 'stat-removed', `-${file.removedLines}`));

  const fileActions = el('div', 'file-actions');
  const keepBtn = btn('✓', 'btn-action btn-action-keep', () => vscode.postMessage({ command: 'acceptFile', filePath: file.filePath }));
  keepBtn.title = 'Accept all changes';
  const undoBtn = btn('↺', 'btn-action btn-action-discard', () => vscode.postMessage({ command: 'discardFile', filePath: file.filePath }));
  undoBtn.title = 'Discard all changes';
  fileActions.appendChild(keepBtn);
  fileActions.appendChild(undoBtn);

  right.appendChild(changeStrip(file));
  right.appendChild(stats);
  right.appendChild(fileActions);

  fileRow.appendChild(chevron);
  fileRow.appendChild(fileIcon);
  fileRow.appendChild(name);
  if (badge) fileRow.appendChild(badge);
  if (dir) fileRow.appendChild(dir);
  fileRow.appendChild(right);
  group.appendChild(fileRow);

  if (isExpanded) {
    const hunkList = el('div', 'hunk-list');
    for (const hunk of file.hunks) {
      const hunkRow = el('div', 'hunk-row');
      hunkRow.addEventListener('click', () => {
        vscode.postMessage({ command: 'jumpToHunk', filePath: hunk.filePath, hunkId: hunk.id });
      });
      const label = el('span', 'hunk-label', `@line ${hunk.newStart}`);
      const hunkStats = el('div', 'hunk-stats');
      hunkStats.appendChild(el('span', 'stat-added', `+${hunk.newLines}`));
      hunkStats.appendChild(document.createTextNode(' '));
      hunkStats.appendChild(el('span', 'stat-removed', `-${hunk.oldLines}`));
      const hunkActions = el('div', 'hunk-actions');
      const hk = btn('✓', 'btn-action btn-action-keep', () => vscode.postMessage({ command: 'acceptHunk', filePath: hunk.filePath, hunkId: hunk.id }));
      hk.title = 'Accept hunk';
      const hu = btn('↺', 'btn-action btn-action-discard', () => vscode.postMessage({ command: 'discardHunk', filePath: hunk.filePath, hunkId: hunk.id }));
      hu.title = 'Discard hunk';
      hunkActions.appendChild(hk);
      hunkActions.appendChild(hu);
      hunkRow.appendChild(label);
      hunkRow.appendChild(hunkStats);
      hunkRow.appendChild(hunkActions);
      hunkList.appendChild(hunkRow);
    }
    group.appendChild(hunkList);
  }

  return group;
}

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.type === 'loading') {
    if (!app) return;
    if (msg.loading) {
      isLoading = true;
      app.innerHTML = '';
      const screen = el('div', 'splash-screen');
      screen.appendChild(el('p', 'splash-tagline', 'Initializing…'));
      const progress = el('p', 'splash-progress', '');
      progress.id = 'loading-progress';
      progress.hidden = true;
      screen.appendChild(progress);
      app.appendChild(screen);
    }
  } else if (msg.type === 'loadingText') {
    // Replace just the progress line: the splash screen is not rebuilt for every update
    const progress = isLoading ? document.getElementById('loading-progress') : null;
    if (progress) {
      progress.textContent = typeof msg.text === 'string' ? msg.text : '';
      progress.hidden = !progress.textContent;
    }
  } else if (msg.type === 'update') {
    currentState = msg.state;
    if (!msg.state.enabled) view = 'main';
    if (isLoading && app) {
      isLoading = false;
      // Render hidden first, then fade in
      app.classList.add('fade-hidden');
      render(msg.state);
      // Force a reflow so the transition fires
      void app.offsetWidth;
      app.classList.remove('fade-hidden');
    } else {
      render(msg.state);
    }
  } else if (msg.type === 'viewport') {
    editorViewport = msg.viewport || null;
    document.querySelectorAll('.file-strip').forEach(placeViewport);
  } else if (msg.type === 'openSettings') {
    view = 'settings';
    if (currentState) render(currentState);
  } else if (msg.type === 'visibilityPing') {
    // Extension asks whether this pane is still on screen (a hidden webview has no viewport)
    const shown = document.visibilityState === 'visible' && window.innerWidth > 0 && window.innerHeight > 0;
    vscode.postMessage({ command: 'visibilityPong', id: msg.id, shown });
  }
});

vscode.postMessage({ command: 'ready' });
