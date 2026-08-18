import { StorageDriver, StorageObject, storageError } from './types';

/**
 * Supabase Storage driver — talks to the public Storage REST API with the
 * service-role key (server-side only; the key NEVER leaves the server).
 *
 * Bucket layout:
 *  - "screenshots"  — private bucket, objects at <orgId>/<uuid>.<ext>
 *  - "avatars"      — public bucket (avatars are <img>-tagged by the UI)
 *
 * Endpoints used (Storage v1):
 *  upload   POST   /storage/v1/object/{bucket}/{key}          (x-upsert)
 *  download GET    /storage/v1/object/{bucket}/{key}
 *  delete   DELETE /storage/v1/object/{bucket}/{key}
 *  sign     POST   /storage/v1/object/sign/{bucket}/{key}
 *  public   GET    /storage/v1/object/public/{bucket}/{key}
 *
 * Keys are constructed from server-controlled values only (orgId + UUID
 * filenames), never from user input.
 */
export class SupabaseStorageDriver implements StorageDriver {
  readonly kind = 'supabase' as const;

  constructor(
    private readonly projectUrl: string,
    private readonly serviceRoleKey: string
  ) {}

  private base = () => `${this.projectUrl.replace(/\/+$/, '')}/storage/v1`;

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.serviceRoleKey}`,
      ...extra,
    };
  }

  async put(key: string, object: StorageObject): Promise<void> {
    const [bucket, ...rest] = key.split('/');
    const objectKey = rest.join('/');
    const res = await fetch(`${this.base()}/object/${encodeURIComponent(bucket)}/${encodeKey(objectKey)}`, {
      method: 'POST',
      headers: this.authHeaders({
        'Content-Type': object.contentType,
        'x-upsert': 'true',
      }),
      body: new Uint8Array(object.bytes),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw storageError('unavailable', `Supabase Storage upload failed (${res.status}): ${detail.slice(0, 200)}`);
    }
  }

  async get(key: string): Promise<Buffer> {
    const [bucket, ...rest] = key.split('/');
    const objectKey = rest.join('/');
    const res = await fetch(`${this.base()}/object/${encodeURIComponent(bucket)}/${encodeKey(objectKey)}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (res.status === 400) {
      throw storageError('not_found', `Object not found: ${key}`);
    }
    if (!res.ok) {
      throw storageError('unavailable', `Supabase Storage download failed (${res.status})`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const [bucket, ...rest] = key.split('/');
    const objectKey = rest.join('/');
    const res = await fetch(`${this.base()}/object/${encodeURIComponent(bucket)}/${encodeKey(objectKey)}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (res.status === 400) {
      return; // already gone — nothing left to purge
    }
    if (!res.ok) {
      throw storageError('unavailable', `Supabase Storage delete failed (${res.status})`);
    }
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string | null> {
    const [bucket, ...rest] = key.split('/');
    const objectKey = rest.join('/');
    const res = await fetch(`${this.base()}/object/sign/${encodeURIComponent(bucket)}/${encodeKey(objectKey)}`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { signedURL?: string };
    if (!data.signedURL) return null;
    return `${this.projectUrl.replace(/\/+$/, '')}${data.signedURL}`;
  }

  getPublicUrl(key: string): string | null {
    const [bucket, ...rest] = key.split('/');
    const objectKey = rest.join('/');
    return `${this.base()}/object/public/${encodeURIComponent(bucket)}/${encodeKey(objectKey)}`;
  }
}

/** Path-safe key encoding: keep "/" as separators, escape everything else. */
function encodeKey(objectKey: string): string {
  return objectKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}