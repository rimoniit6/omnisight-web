import { db } from '@/lib/db';
import { runScheduledJobs } from './run';
import { installShutdownHandlers } from '@/lib/graceful-shutdown';

// Standalone entry: `npm run jobs` (or a systemd timer / cron) triggers the
// same processors the in-process scheduler runs. Requires Node >= 22.6 with
// tsx available (devDependency) or the project built.
(async () => {
  // Ctrl+C / SIGTERM during a batch: give the in-flight lease-guarded job up
  // to 10s grace before a force exit. Prisma is disconnected in `finally`, so
  // the process always exits cleanly even when a job hung.
  installShutdownHandlers({ exitAfterDrainMs: 10000 });

  let exitCode = 0;
  try {
    const result = await runScheduledJobs();
    console.log(JSON.stringify(result, null, 2));
    exitCode = result.errors.length > 0 ? 1 : 0;
  } catch (error) {
    console.error('Scheduled jobs failed:', error);
    exitCode = 1;
  } finally {
    await db.$disconnect().catch(() => {});
  }
  process.exit(exitCode);
})();