export function createQueueRetryScheduler({
  onRetry,
}: {
  onRetry: () => void;
}) {
  let queueRetryTimer: NodeJS.Timeout | null = null;

  function scheduleQueueRetry(ms = 1500) {
    if (queueRetryTimer) return;
    queueRetryTimer = setTimeout(() => {
      queueRetryTimer = null;
      onRetry();
    }, Math.max(100, ms));
    queueRetryTimer.unref?.();
  }

  function clearQueueRetryTimer() {
    if (!queueRetryTimer) return;
    clearTimeout(queueRetryTimer);
    queueRetryTimer = null;
  }

  return {
    scheduleQueueRetry,
    clearQueueRetryTimer,
  };
}
