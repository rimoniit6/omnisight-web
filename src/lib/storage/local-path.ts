/**
 * Single source of truth for the local storage root directory.
 *
 * Both LocalStorageDriver and the screenshot orphan sweep derive their
 * local storage paths from this one helper, so there is exactly one place
 * that reads STORAGE_LOCAL_PATH.
 *
 *   STORAGE_LOCAL_PATH set/empty → resolved against process.cwd()
 *   STORAGE_LOCAL_PATH absent    → <process.cwd()>/uploads  (existing default)
 *
 * Relative paths are resolved against cwd; absolute paths are used as-is.
 * URL paths are NOT accepted.
 */
import { join, resolve as pathResolve } from 'path';

/**
 * Base uploads directory for local filesystem storage.
 * This is what LocalStorageDriver uses as its storage root and what the
 * screenshot orphan sweep uses as SCREENSHOT_UPLOAD_DIR's parent.
 */
export function getLocalUploadsRoot(): string {
  const env = process.env.STORAGE_LOCAL_PATH;
  if (env && env.trim()) {
    const raw = env.trim();
    // Absolute paths are used as-is; relative paths are resolved against cwd.
    return pathResolve(process.cwd(), raw);
  }
  return join(process.cwd(), 'uploads');
}

/** Screenshot subdirectory under the local uploads root. */
export function getLocalScreenshotsDir(): string {
  return join(getLocalUploadsRoot(), 'screenshots');
}
