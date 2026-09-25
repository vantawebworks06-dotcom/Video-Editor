/**
 * Run at most `limit` tasks at once; extra tasks wait in FIFO order. A task that has not started
 * when `signal` aborts is rejected with the abort reason instead of running.
 */
export function createLimiter(limit: number, signal?: AbortSignal) {
  let active = 0;
  const queue: (() => void)[] = [];
  const release = () => {
    active--;
    queue.shift()?.();
  };
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      release();
    }
  };
}
