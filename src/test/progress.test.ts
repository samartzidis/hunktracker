import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatProgress, ProgressReporter } from '../progress';

describe('formatProgress', () => {
  it('shows a running count while scanning', () => {
    assert.equal(formatProgress({ phase: 'scanning', done: 12400 }), 'Scanning files… 12,400 found');
    assert.equal(formatProgress({ phase: 'scanning', done: 0 }), 'Scanning files… 0 found');
  });

  it('shows done / total for the phases with a known size', () => {
    assert.equal(formatProgress({ phase: 'saving', done: 3000, total: 48000 }), 'Saving baselines… 3,000 / 48,000');
    assert.equal(formatProgress({ phase: 'comparing', done: 5, total: 5 }), 'Comparing with baselines… 5 / 5');
    assert.equal(formatProgress({ phase: 'checking', done: 1, total: 20 }), 'Checking changed files… 1 / 20');
  });

  it('never shows more than the total or a negative number', () => {
    assert.equal(formatProgress({ phase: 'saving', done: 600, total: 500 }), 'Saving baselines… 500 / 500');
    assert.equal(formatProgress({ phase: 'scanning', done: -3 }), 'Scanning files… 0 found');
  });
});

describe('ProgressReporter', () => {
  const setup = (interval = 150) => {
    let time = 1000;
    const shown: string[] = [];
    const reporter = new ProgressReporter(t => shown.push(t), interval, () => time);
    return { reporter, shown, advance: (ms: number) => { time += ms; } };
  };

  it('lets the first report of a phase through immediately', () => {
    const { reporter, shown } = setup();
    reporter.report({ phase: 'scanning', done: 10 });
    reporter.report({ phase: 'saving', done: 0, total: 100 });
    assert.deepEqual(shown, ['Scanning files… 10 found', 'Saving baselines… 0 / 100']);
  });

  it('drops rapid updates inside the interval and keeps the later ones', () => {
    const { reporter, shown, advance } = setup(150);
    reporter.report({ phase: 'scanning', done: 1 });
    advance(20);
    reporter.report({ phase: 'scanning', done: 2 });
    advance(20);
    reporter.report({ phase: 'scanning', done: 3 });
    assert.equal(shown.length, 1);
    advance(200);
    reporter.report({ phase: 'scanning', done: 4 });
    assert.deepEqual(shown, ['Scanning files… 1 found', 'Scanning files… 4 found']);
  });

  it('always shows the end of a phase, even inside the interval', () => {
    const { reporter, shown, advance } = setup(150);
    reporter.report({ phase: 'saving', done: 0, total: 1000 });
    advance(5);
    reporter.report({ phase: 'saving', done: 500, total: 1000 });
    advance(5);
    reporter.report({ phase: 'saving', done: 1000, total: 1000 });
    assert.deepEqual(shown, ['Saving baselines… 0 / 1,000', 'Saving baselines… 1,000 / 1,000']);
  });

  it('does not repeat an identical text', () => {
    const { reporter, shown, advance } = setup(0);
    reporter.report({ phase: 'scanning', done: 7 });
    advance(500);
    reporter.report({ phase: 'scanning', done: 7 });
    assert.equal(shown.length, 1);
  });

  it('reset makes the next report go through again', () => {
    const { reporter, shown } = setup();
    reporter.report({ phase: 'scanning', done: 7 });
    reporter.reset();
    reporter.report({ phase: 'scanning', done: 7 });
    assert.equal(shown.length, 2);
  });
});
