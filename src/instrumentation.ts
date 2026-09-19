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
 *  4. SaaS device-count sync — keeps Organization.activeDeviceCount accurate on
 *     a ~30-minute cadence (requirement: every 30 min) instead of waiting for
 *     the hourly maintenance pass. Dev AND production. Cadence
 *     SYNC_DEVICE_COUNT_INTERVAL_SECONDS (default 1800s = 30min, min 300s),
 *     same JobRun lease so it is exclusive with the hourly pass.
 *  5. Infrastructure DATA MIGRATION runner — processes approved change
 *     requests' queued migrations (org-scoped data copy → verification →
 *     ready_to_activate). Dev AND production. Cadence
 *     INFRA_MIGRATION_INTERVAL_SECONDS (default 30s, min 10s). Concurrency is
 *     guarded by an atomic DB claim inside the runner itself, so it never
 *     double-runs a migration even across processes.
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

  // Fail fast on missing/incorrect required environment variables before any
  // other initialisation. Throws with a clear message when misconfigured.
  const { validateEnv, readIntervalSeconds } = await import('@/lib/env-validator');
  validateEnv();

  // Graceful shutdown uses Node-only APIs (process signals, process.exit,
  // timeout .unref()). Importing it here — AFTER the NEXT_RUNTIME guard —
  // keeps graceful-shutdown out of the Edge instrumentation graph that
  // Next.js compiles from this file, exactly like env-validator, jobs/run,
  // migration/runner and db below.
  const { installShutdownHandlers, isDraining, registerDrainable } = await import('@/lib/graceful-shutdown');

  // NOTE: the self-hosted startup license check was removed with the
  // LicenseKey / self-hosted architecture (not a V1 service model).

  const g = globalThis as unknown as {
    __jobsSchedulerStarted?: boolean;
    __projectTimeLoopStarted?: boolean;
    __screenshotProcessingLoopStarted?: boolean;
    __syncDeviceCountLoopStarted?: boolean;
    __infraMigrationLoopStarted?: boolean;
  };

  // Every scheduler interval is tracked here so graceful shutdown can stop
  // them all in one go (see the drainable registered at the bottom of this
  // function).
  const schedulerTimers: Array<ReturnType<typeof setInterval>> = [];

  // 1. Hourly maintenance scheduler (production only — matches prior behavior).
  if (process.env.NODE_ENV === 'production' && !g.__jobsSchedulerStarted) {
    g.__jobsSchedulerStarted = true;

    const { runScheduledJobs } = await import('@/lib/jobs/run');

    const safeInterval = readIntervalSeconds('JOBS_INTERVAL_SECONDS', 3600, 60);

    const tick = () => {
      if (isDraining()) return;
      runScheduledJobs().catch((error) => console.error('[jobs] scheduled run failed:', error));
    };
    await tick();
    schedulerTimers.push(setInterval(tick, safeInterval * 1000));

    console.log(`[jobs] scheduler started (interval ${safeInterval}s)`);
  }

  // 2. Realtime project-time sync loop — dev AND production.
  if (!g.__projectTimeLoopStarted) {
    g.__projectTimeLoopStarted = true;

    const { runProjectTimeSyncJob } = await import('@/lib/jobs/run');

    const safeInterval = readIntervalSeconds('PROJECT_TIME_SYNC_INTERVAL_SECONDS', 60, 15);

    const tick = () => {
      if (isDraining()) return;
      runProjectTimeSyncJob().catch((error) => console.error('[jobs] project-time sync run failed:', error));
    };
    await tick();
    schedulerTimers.push(setInterval(tick, safeInterval * 1000));

    console.log(`[jobs] project-time sync loop started (interval ${safeInterval}s)`);
  }

  // 3. Screenshot thumbnail processing loop — dev AND production. Runs on its
  // own JobRun lease ('screenshot_processing'), so it never double-runs with
  // the hourly scheduler or `npm run jobs`.
  if (!g.__screenshotProcessingLoopStarted) {
    g.__screenshotProcessingLoopStarted = true;

    const { runScreenshotProcessingJob } = await import('@/lib/jobs/run');

    const safeInterval = readIntervalSeconds('SCREENSHOT_PROCESSING_INTERVAL_SECONDS', 60, 15);

    const tick = () => {
      if (isDraining()) return;
      runScreenshotProcessingJob().catch((error) =>
        console.error('[jobs] screenshot processing run failed:', error)
      );
    };
    await tick();
    schedulerTimers.push(setInterval(tick, safeInterval * 1000));

    console.log(`[jobs] screenshot processing loop started (interval ${safeInterval}s)`);
  }

  // 4. SaaS device-count sync loop — dev AND production, ~30-minute cadence.
  //    Shares the 'sync_device_count' JobRun lease with the hourly pass, so it
  //    never double-runs.
  if (!g.__syncDeviceCountLoopStarted) {
    g.__syncDeviceCountLoopStarted = true;

    const { runSyncDeviceCountsJob } = await import('@/lib/jobs/run');

    const safeInterval = readIntervalSeconds('SYNC_DEVICE_COUNT_INTERVAL_SECONDS', 1800, 300);

    const tick = () => {
      if (isDraining()) return;
      runSyncDeviceCountsJob().catch((error) =>
        console.error('[jobs] device-count sync run failed:', error)
      );
    };
    await tick();
    schedulerTimers.push(setInterval(tick, safeInterval * 1000));

    console.log(`[jobs] device-count sync loop started (interval ${safeInterval}s)`);
  }

  // 5. Infrastructure data-migration runner loop — dev AND production.
  //    Runs approved change requests' queued migrations. The runner claims
  //    each migration atomically (queued → migrating updateMany), so multiple
  //    server processes never run the same migration twice.
  if (!g.__infraMigrationLoopStarted) {
    g.__infraMigrationLoopStarted = true;

    const { runMigrationJob } = await import('@/lib/migration/runner');

    const safeInterval = readIntervalSeconds('INFRA_MIGRATION_INTERVAL_SECONDS', 30, 10);

    const tick = () => {
      if (isDraining()) return;
      runMigrationJob().catch((error) =>
        console.error('[jobs] infrastructure migration run failed:', error)
      );
    };
    await tick();
    schedulerTimers.push(setInterval(tick, safeInterval * 1000));

    console.log(`[jobs] infrastructure migration loop started (interval ${safeInterval}s)`);
  }

  // Graceful shutdown: on SIGTERM/SIGINT stop scheduling new job runs, give
  // the in-flight lease-guarded run a short grace window, disconnect Prisma,
  // then exit. JobRun leases are crash-safe, so a hard kill past the grace
  // window can never double-execute a job.
  registerDrainable({
    name: 'instrumentation-schedulers',
    stop: () => {
      for (const timer of schedulerTimers) clearInterval(timer);
    },
  });
  installShutdownHandlers({
    exitAfterDrainMs: 5000,
    onDrainComplete: async () => {
      try {
        const { db } = await import('@/lib/db');
        await db.$disconnect();
      } catch (error) {
        console.error('[jobs] prisma disconnect during drain failed:', error);
      }
    },
  });
}
