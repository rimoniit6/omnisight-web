/**
 * Next.js instrumentation — starts the background job scheduler once per
 * server process.
 *
 * Three independent schedulers:
 *  1. Hourly maintenance jobs (consent expiry + retention cleanup) — production
 *     only, cadence JOBS_INTERVAL_SECONDS (default 1h). Can also be triggered
 *     manually via `npm run jobs`.
 *  2. Realtime automatic project-time sync — runs in dev AND production so
 *     assigned employees' real activity becomes project time without waiting
 *     for the hourly run. Cadence PROJECT_TIME_SYNC_INTERVAL_SECONDS (default
 *     60s, min 15s). It uses its own JobRun lease, so it is always exclusive
 *     with the hourly scheduler and `npm run jobs`.
 *  3. Screenshot thumbnail processing — runs in dev AND production so newly
 *     uploaded screenshots get thumbnails within ~a minute instead of waiting
 *     for the hourly maintenance run. Cadence
 *     SCREENSHOT_PROCESSING_INTERVAL_SECONDS (default 60s, min 15s), bounded
 *     per run (default 100 rows), same JobRun lease so it is exclusive with
 *     every other scheduler invocation.
 */
export async function register() {
  // Runtime boundary: Next.js compiles instrumentation.ts for BOTH the Node.js
  // and Edge runtimes. The job scheduler below (and its transitive imports:
  // Prisma, fs/path-backed retention + screenshot storage) is Node-only, so it
  // must never be loaded/executed from the Edge runtime. NEXT_RUNTIME is a
  // build-time constant ('nodejs' | 'edge') per bundle, so this guard drops the
  // dynamic imports from the Edge instrumentation graph entirely. Dev-mode
  // edge compiles reuse this same source; the guard keeps them Node-only too.
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  const g = globalThis as unknown as {
    __jobsSchedulerStarted?: boolean;
    __projectTimeLoopStarted?: boolean;
    __screenshotProcessingLoopStarted?: boolean;
  };

  // 1. Hourly maintenance scheduler (production only — matches prior behavior).
  if (process.env.NODE_ENV === 'production' && !g.__jobsSchedulerStarted) {
    g.__jobsSchedulerStarted = true;

    const { runScheduledJobs } = await import('@/lib/jobs/run');

    const intervalSec = parseInt(process.env.JOBS_INTERVAL_SECONDS || '3600', 10);
    const safeInterval = Number.isFinite(intervalSec) && intervalSec >= 60 ? intervalSec : 3600;

    await runScheduledJobs().catch((error) => console.error('[jobs] startup run failed:', error));
    setInterval(() => {
      runScheduledJobs().catch((error) => console.error('[jobs] scheduled run failed:', error));
    }, safeInterval * 1000);

    console.log(`[jobs] scheduler started (interval ${safeInterval}s)`);
  }

  // 2. Realtime project-time sync loop — dev AND production.
  if (!g.__projectTimeLoopStarted) {
    g.__projectTimeLoopStarted = true;

    const { runProjectTimeSyncJob } = await import('@/lib/jobs/run');

    const intervalSec = parseInt(process.env.PROJECT_TIME_SYNC_INTERVAL_SECONDS || '60', 10);
    const safeInterval = Number.isFinite(intervalSec) && intervalSec >= 15 ? intervalSec : 60;

    const tick = () => {
      runProjectTimeSyncJob().catch((error) => console.error('[jobs] project-time sync run failed:', error));
    };
    await tick();
    setInterval(tick, safeInterval * 1000);

    console.log(`[jobs] project-time sync loop started (interval ${safeInterval}s)`);
  }

  // 3. Screenshot thumbnail processing loop — dev AND production. Runs on its
  // own JobRun lease ('screenshot_processing'), so it never double-runs with
  // the hourly scheduler or `npm run jobs`.
  if (!g.__screenshotProcessingLoopStarted) {
    g.__screenshotProcessingLoopStarted = true;

    const { runScreenshotProcessingJob } = await import('@/lib/jobs/run');

    const intervalSec = parseInt(process.env.SCREENSHOT_PROCESSING_INTERVAL_SECONDS || '60', 10);
    const safeInterval = Number.isFinite(intervalSec) && intervalSec >= 15 ? intervalSec : 60;

    const tick = () => {
      runScreenshotProcessingJob().catch((error) =>
        console.error('[jobs] screenshot processing run failed:', error)
      );
    };
    await tick();
    setInterval(tick, safeInterval * 1000);

    console.log(`[jobs] screenshot processing loop started (interval ${safeInterval}s)`);
  }
}
