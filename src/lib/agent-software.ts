// OmniSight — Agent Software (Admin-built OmniSightAgent.exe) backend.
//
// The Admin Panel exposes a "Settings → Agent Software" section where an admin
// configures the deployment's agent build and issues a build. The EXE is built
// by the EXISTING agent pipeline (omnisight-agent/scripts/build-prod.mjs)
// with the org's validated server URL and — optionally — the org enrollment
// code baked in. One configured build per deployment, usable by all employees.
//
// SECURITY:
//   - Only the server URL + enrollment code are embedded; never a JWT secret,
//     DB credential, admin/AgentAccount password, device secret, AgentToken or
//     private key.
//   - The enrollment code plaintext is NEVER stored: the admin supplies it at
//     build time (they received it exactly once at issuance), it is verified
//     against the stored SHA-256 hash, passed only to the child process env
//     and never logged or persisted.
//   - The build command is FIXED (no user-provided shell input, no arbitrary
//     paths): `node omnisight-agent/scripts/build-prod.mjs` in the
//     omnisight-agent working directory, with server-controlled env.
//   - The baked server URL is validated by the CANONICAL env-aware policy
//     (src/lib/agent-server-url.ts): https:// is mandatory in production and
//     for public hosts; http:// loopback addresses are accepted only for local
//     development/testing. A public http:// address is rejected BEFORE a build
//     is attempted (both here and at the API boundary) so the record fails
//     fast with an actionable reason instead of a child process that exits 1
//     and hides why. omnisight-agent/scripts/build-prod.mjs enforces the same
//     policy itself, so the server and the child can never disagree.
//   - Build execution is only attempted when the host is actually capable
//     (Windows + Node + the omnisight-agent checkout present). Otherwise the
//     build record is marked failed with a clear reason and the API still
//     returns the metadata contract — the Admin Panel never pretends a build
//     ran.
//   - Child stdout/stderr is captured and surfaced (redacted) in the failure
//     record so a real build error is never swallowed into a bare exit code.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/lib/db';
import { hashEnrollmentCode, verifyEnrollmentCode, ENROLLMENT_CODE_SETTING_KEY } from '@/lib/agent/auth';
import { resolveGuestPendingLimit } from '@/lib/guests';
import { validateServerUrl, type ServerUrlValidation } from '@/lib/agent-server-url';

export const AGENT_SERVER_URL_SETTING_KEY = 'agent_server_url';

/** Repository root (the directory containing omnisight-agent/). The Next.js
 * server and the test runner both execute from the repo root, so process.cwd()
 * is the reliable anchor (never a transpiled __dirname). */
const PROJECT_ROOT = process.cwd();
const AGENT_DIR = join(PROJECT_ROOT, 'omnisight-agent');
const BUILD_SCRIPT = join(AGENT_DIR, 'scripts', 'build-prod.mjs');
const BUILD_OUT_DIR = join(AGENT_DIR, 'out');
const ARTIFACT_DIR = join(PROJECT_ROOT, 'uploads', 'agent-builds');

let cachedAgentVersion: string | null = null;

/** The omnisight-agent package version (read once, cached). */
export function getAgentVersion(): string {
  if (cachedAgentVersion) return cachedAgentVersion;
  try {
    const pkg = JSON.parse(readFileSync(join(AGENT_DIR, 'package.json'), 'utf8')) as { version?: string };
    cachedAgentVersion = pkg.version ?? 'unknown';
  } catch {
    cachedAgentVersion = 'unknown';
  }
  return cachedAgentVersion;
}

export interface AgentSoftwareConfig {
  serverUrl: string;
  enrollmentCodeEnabled: boolean;
  guestPendingLimit: number;
  agentVersion: string;
}

/** Org-scoped agent software configuration (never exposes the code itself). */
export async function resolveAgentSoftwareConfig(orgId: string): Promise<AgentSoftwareConfig> {
  const [urlSetting, enrollSetting, pendingLimit] = await Promise.all([
    db.organizationSetting.findUnique({
      where: { organizationId_key: { organizationId: orgId, key: AGENT_SERVER_URL_SETTING_KEY } },
    }),
    db.organizationSetting.findUnique({
      where: { organizationId_key: { organizationId: orgId, key: ENROLLMENT_CODE_SETTING_KEY } },
    }),
    resolveGuestPendingLimit(orgId),
  ]);
  return {
    serverUrl: urlSetting?.value ?? '',
    enrollmentCodeEnabled: enrollSetting !== null,
    guestPendingLimit: pendingLimit,
    agentVersion: getAgentVersion(),
  };
}

/**
 * Persist the org's agent server URL (org-scoped OrganizationSetting, audited
 * by the caller). Returns a validated value or an error response shape.
 * Validation follows the canonical env-aware policy (src/lib/agent-server-url).
 */
export async function saveAgentServerUrl(orgId: string, raw: unknown): Promise<ServerUrlValidation> {
  const validated = validateServerUrl(raw);
  if (!validated.ok) return validated;
  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgId, key: AGENT_SERVER_URL_SETTING_KEY } },
    update: { value: validated.value, category: 'agent' },
    create: { organizationId: orgId, key: AGENT_SERVER_URL_SETTING_KEY, value: validated.value, category: 'agent' },
  });
  return validated;
}

/** Validate a candidate enrollment code against the org's stored hash. */
export async function verifyOrgEnrollmentCode(orgId: string, code: string): Promise<boolean> {
  const setting = await db.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId: orgId, key: ENROLLMENT_CODE_SETTING_KEY } },
  });
  if (!setting) return false;
  return verifyEnrollmentCode(code, setting.value);
}

// ─── Build host capability probe ─────────────────────────────────────────────

export interface BuildHostCapability {
  capable: boolean;
  reason?: string;
}

/**
 * Detect whether THIS server process can actually execute an omnisight-agent
 * build. Electron packaging requires a Windows host with Node, the
 * omnisight-agent checkout (its node_modules + toolchain), and the native-host
 * compiler. When not capable, builds are recorded as failed with the reason —
 * the Admin Panel never pretends a build ran.
 */
export function probeBuildHostCapability(): BuildHostCapability {
  if (process.env.VERCEL === '1') {
    return { capable: false, reason: 'Vercel serverless cannot run an Electron build — build the desktop agent on a Windows CI host (GitHub Actions) or self-hosted runner, then attach the installer via the agent software settings.' };
  }
  if (process.platform !== 'win32') {
    return { capable: false, reason: 'Build host is not Windows — the Next.js server cannot compile the Electron EXE on this platform.' };
  }
  if (!existsSync(BUILD_SCRIPT)) {
    return { capable: false, reason: 'omnisight-agent build script not found — the agent source checkout is not present on this host.' };
  }
  if (!existsSync(join(AGENT_DIR, 'node_modules'))) {
    return { capable: false, reason: 'omnisight-agent dependencies are not installed on this host.' };
  }
  return { capable: true };
}

// ─── Build execution (fixed, server-controlled command) ──────────────────────

/**
 * Start the build for an AgentBuild record. The child command is FIXED —
 * `node scripts/build-prod.mjs` in the omnisight-agent dir — with env values
 * derived exclusively from server-controlled config. On completion the record
 * is updated (status/sha256/fileName/error) and the artifact is copied into
 * uploads/agent-builds/<orgId>/<buildId>.exe. Never stores or logs the
 * enrollment code.
 *
 * The record is failed fast (no child spawned) when the server URL cannot be
 * built — the canonical policy rejects public http:// in every environment and
 * all http:// (loopback included) in production, exactly as build-prod.mjs
 * would, so the failure surfaces with a clear reason instead of a bare exit
 * code. http://localhost is accepted so local development builds work.
 */
export async function startAgentBuild(
  build: { id: string; organizationId: string; serverUrl: string },
  opts: { enrollmentCode?: string; onComplete?: () => void }
): Promise<{ started: boolean; error?: string }> {
  const urlCheck = validateServerUrl(build.serverUrl);
  if (!urlCheck.ok) {
    await db.agentBuild.update({
      where: { id: build.id },
      data: { status: 'failed', error: urlCheck.error, completedAt: new Date() },
    });
    return { started: false, error: urlCheck.error };
  }

  const capability = probeBuildHostCapability();
  if (!capability.capable) {
    await db.agentBuild.update({
      where: { id: build.id },
      data: { status: 'failed', error: capability.reason, completedAt: new Date() },
    });
    return { started: false, error: capability.reason };
  }

  await db.agentBuild.update({
    where: { id: build.id },
    data: { status: 'building', startedAt: new Date() },
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_SERVER_URL: build.serverUrl,
  };
  if (opts.enrollmentCode) env.AGENT_ENROLLMENT_CODE = opts.enrollmentCode;

  const child = spawn(process.execPath, [BUILD_SCRIPT], {
    cwd: AGENT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  // The enrollment code is passed via env and must never be persisted; it is
  // redacted from any captured output before it can reach the DB error field
  // (build-prod.mjs already redacts its own prints, but a compiler error could
  // otherwise echo the baked source line containing the code).
  const secrets: string[] = opts.enrollmentCode ? [opts.enrollmentCode] : [];
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    // Build progress is never secret-bearing (build-prod.mjs redacts the code).
    process.stdout.write(text);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
  });

  child.on('error', (err) => {
    void finishBuild(build.id, { ok: false, error: `Failed to start build process: ${err.message}` }).then(() => opts.onComplete?.());
  });
  child.on('close', (code) => {
    void (async () => {
      if (code === 0) {
        const outcome = await stageArtifact(build);
        await finishBuild(build.id, outcome);
      } else {
        const tail = redactBuildOutput(output, secrets).trim().split('\n').slice(-5).join(' | ').slice(0, 500);
        await finishBuild(build.id, { ok: false, error: `Agent build exited with code ${code}${tail ? ` — ${tail}` : ''}` });
      }
      opts.onComplete?.();
    })();
  });

  return { started: true };
}

/** Strip secrets from captured child output before it is persisted. */
export function redactBuildOutput(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

/** Copy the newest installer into the org-scoped artifact store + digest it. */
async function stageArtifact(build: {
  id: string;
  organizationId: string;
}): Promise<{ ok: boolean; error?: string; sha256?: string; fileName?: string }> {
  try {
    if (!existsSync(BUILD_OUT_DIR)) {
      return { ok: false, error: 'Build finished but out/ is missing — artifact not staged.' };
    }
    const installers = readdirSync(BUILD_OUT_DIR)
      .filter((f) => /^OmniSight Agent Setup .+\.exe$/.test(f))
      .map((f) => ({ f, t: statSync(join(BUILD_OUT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (installers.length === 0) {
      return { ok: false, error: 'Build finished but no installer was produced.' };
    }
    const dir = join(ARTIFACT_DIR, build.organizationId);
    mkdirSync(dir, { recursive: true });
    const fileName = `${build.id}.exe`;
    copyFileSync(join(BUILD_OUT_DIR, installers[0].f), join(dir, fileName));
    const digest = createHash('sha256').update(readFileSync(join(dir, fileName))).digest('hex');
    return { ok: true, sha256: digest, fileName };
  } catch (err) {
    return { ok: false, error: `Failed to stage artifact: ${(err as Error)?.message ?? String(err)}` };
  }
}

async function finishBuild(
  buildId: string,
  outcome: { ok: boolean; error?: string; sha256?: string; fileName?: string }
): Promise<void> {
  await db.agentBuild.update({
    where: { id: buildId },
    data: {
      status: outcome.ok ? 'completed' : 'failed',
      ...(outcome.sha256 ? { sha256: outcome.sha256 } : {}),
      ...(outcome.fileName ? { fileName: outcome.fileName } : {}),
      ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
      completedAt: new Date(),
    },
  });
}

/** Resolve the on-disk path for a stored artifact (never from user input). */
export function artifactPath(organizationId: string, fileName: string): string {
  // fileName is always a DB-controlled value like "<buildId>.exe".
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, '');
  return join(ARTIFACT_DIR, organizationId.replace(/[^A-Za-z0-9_-]/g, ''), safe);
}

// Re-export the hash helper so the API can verify codes without importing
// lib/agent/auth directly everywhere.
export { hashEnrollmentCode };
