export async function runWatcherPollingLoop(
  poll: () => Promise<unknown>,
  pollIntervalMs: number,
  options: {
    maxConsecutiveFailures?: number;
    failureRetryIntervalMs?: number;
    shouldContinue?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
    reportError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
  const failureRetryIntervalMs = options.failureRetryIntervalMs ?? pollIntervalMs;
  const shouldContinue = options.shouldContinue ?? (() => true);
  const sleepBetweenPolls = options.sleep ?? sleep;
  const reportError =
    options.reportError ?? ((error) => console.error("Watcher poll failed; retrying:", error));
  let consecutiveFailures = 0;

  while (shouldContinue()) {
    let nextPollDelayMs = pollIntervalMs;
    try {
      await poll();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      reportError(error);
      if (consecutiveFailures >= maxConsecutiveFailures) throw error;
      nextPollDelayMs = failureRetryIntervalMs;
    }
    if (shouldContinue()) await sleepBetweenPolls(nextPollDelayMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
