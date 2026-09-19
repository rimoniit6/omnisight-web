#!/usr/bin/env node
// Projection discipline gate (see docs/PROJECTION-SWEEP.md).
//
// `omnisight/prisma-select` runs at WARN in the main lint sweep because the
// remaining full-row reads are tracked debt (pagination-scoped feed/list
// endpoints that serialize whole rows — see the debt table in the doc). This
// gate flips the rule to ERROR over the CURATED set of files already narrowed
// with `select`, so a net-new full-row findMany can never silently regress a
// refactored surface. When you narrow another file, add it to FILES.
//
// Exit code is nonzero on any error; run with `npm run lint:projections`.
import { spawnSync } from 'node:child_process';
import { accessSync } from 'node:fs';
import { resolve } from 'node:path';

const CWD = process.cwd();

// Repository-relative paths (POSIX separators; eslint accepts them on all
// platforms). Content must be alphabetized, one file per line.
const FILES = [
  'src/app/api/admin/infrastructure-requests/route.ts',
  'src/app/api/category-rules/dry-run/route.ts',
  'src/app/api/device-claims/[id]/approve/route.ts',
  'src/app/api/employees/[id]/keyboard/route.ts',
  'src/app/api/employees/[id]/location/route.ts',
  'src/app/api/employees/[id]/performance/route.ts',
  'src/app/api/employees/[id]/webcam/route.ts',
  'src/app/api/organization/ai-settings/route.ts',
  'src/app/api/plans/route.ts',
  'src/app/api/reports/daily/ai-summary/route.ts',
  'src/app/api/reports/generate/route.ts',
  'src/app/api/reports/pdf/audit/route.ts',
  'src/app/api/reports/pdf/dashboard/route.ts',
  'src/app/api/sentiment/analyze/route.ts',
  'src/app/api/settings/monitoring/route.ts',
  'src/app/api/settings/retention/route.ts',
  'src/lib/jobs/settings.ts',
  'src/lib/migration/runner.ts',
  'src/lib/pricing.ts',
];

function main() {
  let missing = 0;
  for (const f of FILES) {
    try {
      accessSync(resolve(CWD, f));
    } catch {
      console.error(`lint-projections: listed file does not exist: ${f}`);
      missing++;
    }
  }
  if (missing > 0) {
    console.error(`Remove ${missing} stale path(s) from scripts/lint-projections.mjs`);
    return 1;
  }

  const eslintCli = resolve(CWD, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const res = spawnSync(
    process.execPath,
    [eslintCli, ...FILES, '--rule', 'omnisight/prisma-select: error'],
    { cwd: CWD, stdio: 'inherit' }
  );
  if (res.error) {
    console.error(`lint-projections: failed to spawn eslint: ${res.error.message}`);
    return 1;
  }
  if (res.status === 0) {
    console.log(`lint-projections: ${FILES.length} refactored file(s) clean — no full-row findMany.`);
    return 0;
  }
  return res.status ?? 1;
}

process.exitCode = main();