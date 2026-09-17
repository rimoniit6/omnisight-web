import { StorageDriver, StorageObject, storageError } from './types';

/**
 * Supabase Storage driver — talks to the public Storage REST API with the
 * service-role key (server-side only; the key NEVER leaves the server).
 *
 * The credential is presented through BOTH `apikey` and `Authorization: Bearer`
 * (see authHeaders). This supports BOTH Supabase key generations: the legacy
 * `service_role` JWT and the new-style opaque `sb_secret_…` keys, which the
 * Storage API accepts through the `apikey` presentation — an Authorization-only
 * request with an sb_secret_ key is rejected as "Invalid Compact JWS".
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

  /**
   * Shared authentication headers for EVERY Storage API call (put/get/delete/
   * sign). The same credential is sent through both headers so the presentation
   * matches the proven-good connection-test path (src/lib/infra-connect.ts).
   * Forensic root cause of the migration 403 "Invalid Compact JWS": this
   * helper used to send Authorization only, so a non-JWT sb_secret_ key reached
   * the Storage JWT verification path and was rejected. Keep all operations on
   * this helper — do not duplicate header logic per method.
   */
  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.serviceRoleKey,
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
      throw storageError('unavailable', storageFailureMessage('upload', res.status, detail));
    }
  }

  async get(key: string): Promise<Buffer> {
    const [bucket, ...rest] = key.split('/');
    const objectKey = rest.join('/');
    const res = await fetch(`${this.base()}/object/${encodeURIComponent(bucket)}/${encodeKey(objectKey)}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (isStorageNotFoundResponse(res.status, detail)) {
        throw storageError('not_found', `Object not found: ${key}`);
      }
      // Auth/server failures must NOT masquerade as a missing object — a 403
      // "Invalid Compact JWS" used to surface only as a bogus not_found here.
      throw storageError('unavailable', storageFailureMessage('download', res.status, detail));
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
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (isStorageNotFoundResponse(res.status, detail)) {
        return; // already gone — nothing left to purge
      }
      throw storageError('unavailable', storageFailureMessage('delete', res.status, detail));
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

  /** Supabase Storage is object storage, not a locally reachable filesystem. */
  isFilesystemBacked(): boolean {
    return false;
  }
}

/**
 * True when a response is the Storage API's GENUINE object-not-found shape.
 * Missing objects answer HTTP 404 — or, on the legacy Storage contract, HTTP
 * 400 with the exact "The resource was not found" body. ONLY those shapes may
 * be classified as not_found: any other 4xx — in particular 401/403
 * authentication failures ("Invalid Compact JWS") and 400s with a different
 * body — must surface as an error, never as a missing object.
 */
function isStorageNotFoundResponse(status: number, body: string): boolean {
  if (status === 404) return true;
  return status === 400 && /the resource was not found/i.test(body);
}

/**
 * Sanitized, actionable failure message for non-ok Storage responses.
 * Authentication failures get an explicit, check-your-key message; the server
 * detail is included (Storage error bodies never echo request credentials) and
 * the secret/API key itself is NEVER part of any error or log line.
 */
function storageFailureMessage(action: string, status: number, detail: string): string {
  if (status === 401 || status === 403) {
    return `Supabase Storage ${action} failed (${status}): authentication rejected by the destination project — check the configured service-role/secret key. ${detail.slice(0, 200)}`.trim();
  }
  return `Supabase Storage ${action} failed (${status}): ${detail.slice(0, 200)}`;
}

/** Path-safe key encoding: keep "/" as separators, escape everything else. */
function encodeKey(objectKey: string): string {
  return objectKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}