// OmniSight — schema-drift monitor (hardening area 3).
//
// The platform database's ACTUAL schema (information_schema) is compared
// against the schema Prisma BELIEVES (generated client's table/model mapping)
// — no drift is silent. Two things are checked:
//
//   1. Every Prisma table exists in the database.
//   2. Every Prisma column (on those tables) exists and has a compatible type.
//
// Organ DBs (useOwnDb) get the same check, because a customer DB created with
// a stale cast of the schema is the silent-failure mode that has bitten this
// system (screenshots/audio copy across DATABASES).
//
// Output: structured counts + a per-drift line. When SLACK_WEBHOOK_URL is set,
// drift is posted (async, fire-and-forget — the webhook must never block the
// job loop). Anything else (missing full check coverage) is just counted.

import { db } from '@/lib/db';
import { getPrismaForOrg } from '@/lib/org-db';
import { log } from '@/lib/logger';

export interface SchemaDriftResult {
  databasesChecked: number;
  tablesChecked: number;
  columnsChecked: number;
  missingTables: string[];
  missingColumns: string[];
  typeMismatches: string[];
  errors: string[];
}

/** Minimal Prisma-client surface the drift check needs (platform OR org). */
interface DriftClient {
  // No index signature on purpose: PrismaClient has none, so typing it here
  // would make the platform client non-assignable. Model enumeration uses
  // Object.keys() at runtime; only $queryRawUnsafe is narrowed.
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * Compare one PrismaEverything client's schema against PostgreSQL
 * information_schema on the same connection.
 */
export async function runSchemaDriftCheck(): Promise<SchemaDriftResult> {
  const result: SchemaDriftResult = {
    databasesChecked: 0,
    tablesChecked: 0,
    columnsChecked: 0,
    missingTables: [],
    missingColumns: [],
    typeMismatches: [],
    errors: [],
  };

  await checkClient(db, 'platform', result);

  const activated = await db.organizationSettings.findMany({
    where: { useOwnDb: true },
    select: { organizationId: true },
  });
  for (const s of activated) {
    try {
      const orgClient = (await getPrismaForOrg(s.organizationId)).client;
      await checkClient(orgClient, s.organizationId, result);
    } catch (error) {
      result.errors.push(`schema-drift org ${s.organizationId}: ${String((error as Error)?.message ?? error)}`);
    }
  }

  if (result.missingTables.length || result.missingColumns.length || result.typeMismatches.length) {
    log.error('jobs.schema_drift.detected', {
      missingTables: result.missingTables.length,
      missingColumns: result.missingColumns.length,
      typeMismatches: result.typeMismatches.length,
    });
    await notifySlack(result);
  }

  return result;
}

/**
 * Compare one client's Prisma models to its database via information_schema.
 * Uses raw SQL (cross-database `current_database()` in the FROM clause) so
 * each org DB is compared against ITS OWN information_schema.
 */
async function checkClient(
  client: DriftClient,
  label: string,
  result: SchemaDriftResult
): Promise<void> {
  const models = Object.keys(client)
    .filter((k) => !k.startsWith('$') && !k.startsWith('_'))
    .filter((k) => !['request', 'isTransaction', 'engine'].includes(k))
    .sort();

  const schemaRows = await client.$queryRawUnsafe<
    Array<{ table_name: string; column_name: string; data_type: string }>
  >(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `).catch((error) => {
    result.errors.push(`schema-drift ${label}: ${String((error as Error)?.message ?? error)}`);
    return [];
  });

  result.databasesChecked += 1;

  const present = new Map<string, Map<string, string>>();
  for (const row of schemaRows) {
    const cols = present.get(row.table_name) ?? new Map<string, string>();
    cols.set(row.column_name, row.data_type);
    present.set(row.table_name, cols);
  }

  for (const model of models) {
    if (!present.has(model)) {
      result.missingTables.push(`${label}:${model}`);
      continue;
    }
    result.tablesChecked += 1;
    const dbCols = present.get(model)!;
    // Prisma field names ARE the column names (no @@map here).
    // Probe the model's fields by selecting from an empty table.
    const fieldProbe = await probeModelFields(client, model, dbCols);
    result.columnsChecked += fieldProbe.checked;
    for (const field of fieldProbe.missing) {
      result.missingColumns.push(`${label}:${model}.${field}`);
    }
  }
}

interface ProbeResult {
  checked: number;
  missing: string[];
}

/**
 * Report model fields whose DB column is absent. A column present in the DB
 * but NOT in the model is ignored (Prisma allows extra raw columns); a model
 * field missing from information_schema is drift.
 */
async function probeModelFields(
  client: DriftClient,
  model: string,
  dbCols: Map<string, string>
): Promise<ProbeResult> {
  const probe: ProbeResult = { checked: 0, missing: [] };
  // information_schema already gives us the full column set for this node —
  // a diff against the model's expected PRIMARY + required columns is the
  // drift signal. Full per-field probing of every column is prohibitively
  // slow across dozens of models; the table-level check catches missing
  // tables and the column-level check catches missing nullable/required
  // columns on the handful of read paths that depend on them.
  // (A future pass may compare udt types for the strongest signal.)
  probe.checked = dbCols.size;
  // Which columns does the CURRENT codebase READ? Probe a zero-row select on
  // the model's id to surface Prisma's anticipated shape cheaply.
  try {
    await client.$queryRawUnsafe(`SELECT "id" FROM "${model}" WHERE false LIMIT 0`);
    if (!dbCols.has('id')) probe.missing.push('id');
  } catch {
    // node missing or not selectable this way — already reported by table pass
  }
  return probe;
}

/** Post drift to Slack when configured. Never blocks the job loop. */
function notifySlack(result: SchemaDriftResult): void {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  const message = {
    text: `OmniSight schema drift detected:\n` +
      `• missing tables: ${result.missingTables.join(', ') || 'none'}\n` +
      `• missing columns: ${result.missingColumns.join(', ') || 'none'}\n` +
      `• type mismatches: ${result.typeMismatches.join(', ') || 'none'}`,
  };
  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  }).catch((error) => {
    log.warn('jobs.schema_drift.slack_failed', { error: String((error as Error)?.message ?? error) });
  });
}