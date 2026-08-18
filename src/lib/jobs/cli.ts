import { runScheduledJobs } from './run';

// Standalone entry: `npm run jobs` (or a systemd timer / cron) triggers the
// same processors the in-process scheduler runs. Requires Node >= 22.6 with
// tsx available (devDependency) or the project built.
(async () => {
  try {
    const result = await runScheduledJobs();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.errors.length > 0 ? 1 : 0);
  } catch (error) {
    console.error('Scheduled jobs failed:', error);
    process.exit(1);
  }
})();
