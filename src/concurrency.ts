/**
 * Run `fn` over `items` with at most `limit` calls in flight at once. Results keep the order of
 * `items`. The first rejection stops handing out new work and is rethrown once running calls settle.
 *
 * Use this instead of `Promise.all(items.map(...))` whenever each call spawns a process or opens a
 * file: with tens of thousands of items an unbounded `Promise.all` starts them all at the same time.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;

  const worker = async (): Promise<void> => {
    while (!failure) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failure = failure ?? { error };
        return;
      }
    }
  };

  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  if (failure) throw failure.error;
  return results;
}
