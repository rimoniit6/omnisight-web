'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';
import { checkRateLimit, getClientIpFromHeaders } from '@/lib/rate-limit';
import { validateServerUrl } from '@/lib/agent-server-url';
import {
  verifyOrgEnrollmentCode,
  getAgentVersion,
  startAgentBuild,
  resolveAgentSoftwareConfig,
} from '@/lib/agent-software';

// POST /api/agent-software/build
// Trigger a build of the OmniSight Agent EXE for THIS organization (admin-only,
// org-scoped, rate-limited, audited).
//
// Body: { serverUrl?: string, enrollmentCode?: string }
//   - serverUrl overrides the stored org setting for this build (validated by
//     the canonical env-aware policy: http://localhost is accepted for local
//     development builds, public http:// and any http:// in production are
//     rejected — the build pipeline refuses to bake them).
//   - enrollmentCode (optional) is the org's enrollment code the admin
//     received at issuance; it is verified against the stored SHA-256 hash,
//     passed ONLY to the build process env, NEVER stored or logged. A build
//     without a code simply ships without baked zero-touch enrollment (codes
//     can still be provisioned via MDM at runtime).
//
// The build command is FIXED (omnisight-agent/scripts/build-prod.mjs); no
// arbitrary shell input, no filesystem paths. When the host cannot execute an
// Electron build, the record is marked failed with a clear reason and the
// metadata contract is still returned.
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const clientIp = getClientIpFromHeaders(req.headers);
    const rl = await checkRateLimit(`agent-software-build:${admin.organizationId}:${clientIp}`, 5, 60 * 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many build requests. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const body = await req.json().catch(() => ({})) as { serverUrl?: unknown; enrollmentCode?: unknown };

    // Resolve the server URL: explicit override → stored org setting. A build
    // can only ever bake a URL the canonical policy accepts — http://localhost
    // for dev builds, https:// otherwise. Reject unbuildable URLs up front with
    // a clear message instead of recording a guaranteed failure.
    let serverUrl: string;
    if (body.serverUrl !== undefined && body.serverUrl !== null && body.serverUrl !== '') {
      const validated = validateServerUrl(body.serverUrl);
      if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 422 });
      serverUrl = validated.value;
    } else {
      const config = await resolveAgentSoftwareConfig(admin.organizationId);
      if (!config.serverUrl) {
        return NextResponse.json(
          { error: 'No server URL configured. Save the server URL first (Settings → Agent Software).' },
          { status: 422 }
        );
      }
      const stored = validateServerUrl(config.serverUrl);
      if (!stored.ok) return NextResponse.json({ error: stored.error }, { status: 422 });
      serverUrl = stored.value;
    }

    // Optional enrollment code — verified against the hash, never stored.
    let enrollmentCode: string | undefined;
    if (typeof body.enrollmentCode === 'string' && body.enrollmentCode.length > 0) {
      if (body.enrollmentCode.length > 256) {
        return NextResponse.json({ error: 'Invalid enrollment code' }, { status: 422 });
      }
      const valid = await verifyOrgEnrollmentCode(admin.organizationId, body.enrollmentCode);
      if (!valid) {
        return NextResponse.json({ error: 'Invalid enrollment code. Issue or rotate a code first.' }, { status: 422 });
      }
      enrollmentCode = body.enrollmentCode;
    }

    const build = await db.agentBuild.create({
      data: {
        organizationId: admin.organizationId,
        serverUrl,
        enrollmentCodeBaked: enrollmentCode !== undefined,
        agentVersion: getAgentVersion(),
        status: 'pending',
        requestedBy: admin.userId,
      },
    });

    await db.auditLog.create({
      data: {
        action: 'agent_build_issued',
        resource: 'agent',
        resourceId: build.id,
        description: `Agent software build requested for the organization (server URL ${serverUrl}, enrollment code ${enrollmentCode !== undefined ? 'baked' : 'not baked'})`,
        userId: admin.userId,
        ipAddress: clientIp,
        organizationId: admin.organizationId,
      },
    });

    // Start (or fail fast with the capability reason). Fire-and-forget — the
    // record is updated on completion and the UI polls GET .../builds/[id].
    void startAgentBuild(build, { enrollmentCode });

    return NextResponse.json({ success: true, buildId: build.id, status: 'pending' }, { status: 202 });
  } catch (error) {
    console.error('Agent software build error:', error);
    return NextResponse.json({ error: 'Failed to start agent build' }, { status: 500 });
  }
}

