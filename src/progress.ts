/**
 * Progress text for the "Initializing…" screen, so a long Enable or startup scan on a big
 * repository shows that it is working. Vscode-free so it can be unit-tested.
 */

export type ProgressPhase = 'scanning' | 'saving' | 'comparing' | 'checking';

export interface ProgressInfo {
  phase: ProgressPhase;
  /** Items finished so far (for `scanning`: files found so far). */
  done: number;
  /** Items in total, when known (not known while scanning). */
  total?: number;
}

export type ProgressFn = (info: ProgressInfo) => void;

const LABELS: Record<ProgressPhase, string> = {
  scanning: 'Scanning files',
  saving: 'Saving baselines',
  comparing: 'Comparing with baselines',
  checking: 'Checking changed files',
};

const count = (n: number): string => Math.max(0, Math.floor(n)).toLocaleString('en-US');

export function formatProgress(info: ProgressInfo): string {
  const label = LABELS[info.phase];
  if (info.total === undefined) {
    return info.phase === 'scanning' ? `${label}… ${count(info.done)} found` : `${label}… ${count(info.done)}`;
  }
  return `${label}… ${count(Math.min(info.done, info.total))} / ${count(info.total)}`;
}

/**
 * Turns a stream of progress reports into a calm stream of texts: the first report of a phase and
 * the end of a phase (done reached total) always go through, the rest at most once per
 * `minIntervalMs`, and a text identical to the last one is dropped.
 */
export class ProgressReporter {
  private lastText = '';
  private lastPhase: ProgressPhase | undefined;
  private lastEmit = 0;

  constructor(
    private readonly emit: (text: string) => void,
    private readonly minIntervalMs = 150,
    private readonly now: () => number = Date.now
  ) {}

  readonly report: ProgressFn = info => {
    const text = formatProgress(info);
    if (text === this.lastText) return;
    const t = this.now();
    const phaseStart = info.phase !== this.lastPhase;
    const phaseEnd = info.total !== undefined && info.done >= info.total;
    if (!phaseStart && !phaseEnd && t - this.lastEmit < this.minIntervalMs) return;
    this.lastText = text;
    this.lastPhase = info.phase;
    this.lastEmit = t;
    this.emit(text);
  };

  /** Forget what was shown, so the next report goes through (a new run starts). */
  reset(): void {
    this.lastText = '';
    this.lastPhase = undefined;
    this.lastEmit = 0;
  }
}
