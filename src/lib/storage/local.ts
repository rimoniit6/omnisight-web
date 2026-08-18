import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import {
  StorageDriver,
  StorageObject,
  storageError,
  SCREENSHOTS_KEY_PREFIX,
  AVATARS_KEY_PREFIX,
} from './types';

/**
 * Filesystem-backed storage (self-hosted / dev / tests).
 *
 * Key → path mapping:
 *  - screenshots/<orgId>/<file>  → <cwd>/uploads/screenshots/<file>
 *    (LEGACY FLAT layout: the org folder is a bucket-scoping concept for
 *     object storage only. Local keeps the pre-migration flat directory so
 *     the orphan-file sweep, existing on-disk files and the DB filePath
 *     values keep matching. The orgId segment is dropped, never a path.)
 *  - avatars/<file>              → <cwd>/public/uploads/avatars/<file>
 *    (public/ keeps the existing avatar URL scheme working without a proxy;
 *     the same files are served through src/app/uploads/avatars/[filename]
 *     on read-only hosts)
 *  - anything else               → <cwd>/uploads/<bucket>/<rest>
 *
 * Keys are always treated as RELATIVE paths: backslashes, leading slashes,
 * "." and ".." segments are neutralized so a crafted key can never escape the
 * storage roots (defense in depth on top of the UUID/sanitized filenames the
 * call sites already generate).
 */
export class LocalStorageDriver implements StorageDriver {
  readonly kind = 'local' as const;

  private rootFor(key: string): string {
    if (key.startsWith(SCREENSHOTS_KEY_PREFIX)) {
      return join(process.cwd(), 'uploads', 'screenshots');
    }
    if (key.startsWith(AVATARS_KEY_PREFIX)) {
      return join(process.cwd(), 'public', 'uploads', 'avatars');
    }
    return join(process.cwd(), 'uploads');
  }

  private resolve(key: string): string {
    const clean = key.replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = clean.split('/').filter((p) => p && p !== '.' && p !== '..');
    if (parts.length === 0) {
      throw storageError('not_found', `Refusing empty storage key`);
    }
    if (key.startsWith(SCREENSHOTS_KEY_PREFIX)) {
      // Drop the bucket AND the orgId segment: the physical root already IS
      // the screenshots dir and local uses the legacy flat layout (see the
      // mapping comment above). Keys shorter than 3 segments (malformed) fall
      // back to the bare root rather than escaping it.
      return join(this.rootFor(key), ...parts.slice(2));
    }
    if (key.startsWith(AVATARS_KEY_PREFIX)) {
      // Drop the bucket segment — rootFor already points at the avatars dir.
      return join(this.rootFor(key), ...parts.slice(1));
    }
    // Generic buckets: <cwd>/uploads/<bucket>/<rest>
    return join(this.rootFor(key), ...parts);
  }

  async put(key: string, object: StorageObject): Promise<void> {
    const abs = this.resolve(key);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, object.bytes);
  }

  async get(key: string): Promise<Buffer> {
    const abs = this.resolve(key);
    try {
      return await fs.readFile(abs);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
        throw storageError('not_found', `Object not found: ${key}`);
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const abs = this.resolve(key);
    try {
      await fs.unlink(abs);
    } catch (error) {
      // ENOENT = already gone; anything else is a real failure.
      if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  async getSignedUrl(): Promise<string | null> {
    return null;
  }

  getPublicUrl(): string | null {
    return null;
  }
}