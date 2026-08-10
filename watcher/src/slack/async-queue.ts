export async function withQueue<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => current);
  queues.set(key, queued);

  await previous.catch(() => {});
  try {
    return await run();
  } finally {
    release();
    if (queues.get(key) === queued) queues.delete(key);
  }
}
