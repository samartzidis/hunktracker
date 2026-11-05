import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { mapLimit } from '../concurrency';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('mapLimit', () => {
  it('never runs more than `limit` calls at once', async () => {
    let running = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 40 }, (_, i) => i), 4, async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(2);
      running--;
    });
    assert.equal(peak, 4);
  });

  it('keeps the order of the input and passes the index', async () => {
    const out = await mapLimit(['a', 'b', 'c', 'd'], 2, async (item, i) => {
      await sleep(item === 'a' ? 10 : 0);
      return `${i}${item}`;
    });
    assert.deepEqual(out, ['0a', '1b', '2c', '3d']);
  });

  it('handles empty input and limits below 1', async () => {
    assert.deepEqual(await mapLimit([], 8, async x => x), []);
    assert.deepEqual(await mapLimit([1, 2, 3], 0, async x => x * 2), [2, 4, 6]);
  });

  it('rethrows the first failure and stops starting new work', async () => {
    let started = 0;
    await assert.rejects(
      mapLimit(Array.from({ length: 100 }, (_, i) => i), 2, async i => {
        started++;
        await sleep(1);
        if (i === 3) throw new Error('boom');
      }),
      /boom/
    );
    assert.ok(started < 100, `started ${started} calls after the failure`);
  });
});
