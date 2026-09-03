// Removes Next.js GENERATED type files that a crashed/interrupted `next dev`
// can leave truncated (observed: `.next/dev/types/validator.ts` broke every
// `tsc --noEmit` and `next build` with TS1128). These directories are
// regenerated on the next `next dev` run and are never part of the production
// output — deleting them is always safe.
//
// Wired into the `clean:types`, `typecheck` and `build` npm scripts.
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

for (const rel of ['.next/dev/types', '.next-audit/dev/types']) {
  rmSync(join(ROOT, rel), { recursive: true, force: true });
}

console.log('[clean-next-types] removed stale generated dev types (.next/dev/types, .next-audit/dev/types)');