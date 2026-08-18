/**
 * M007 — Cleanup OCR verification fixtures (dev-only helper).
 *
 * verify-ocr.mjs deliberately leaves its fixture rows/devices/users/files in
 * place (its run leaves the DB dirty so you can inspect results). Before
 * running the regression suites (verify-e6-consumption expects an integrity
 * clean-state + a 144-row legacy baseline) this script removes every artifact
 * the OCR suite creates:
 *   - Screenshot rows with ocrStatus != 'none' (queue state) or the crafted
 *     test ids (sc_... / b... / del... / s2... / twin...)
 *   - their storage files
 *   - the OCR test devices (hostname ocr-...) + dependent rows
 *   - the usr_ocr_... test users
 *
 * Run: bun scripts/cleanup-ocr-fixtures.mjs
 */
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'

const DB_PATH = process.env.DB_PATH || 'db/custom.db'
const STORAGE_ROOT = path.resolve(process.env.STORAGE_PATH || 'storage/screenshots')

const db = new Database(DB_PATH)
db.run('PRAGMA foreign_keys = ON')
db.run('PRAGMA busy_timeout = 15000')
const qa = (sql, ...args) => db.query(sql).all(...args)
const run = (sql, ...args) => {
  // Retry SQLITE_BUSY a few times (dev server + OCR worker share the DB).
  for (let i = 0; ; i++) {
    try {
      return db.query(sql).run(...args)
    } catch (e) {
      if (e && e.code === 'SQLITE_BUSY' && i < 10) {
        Bun.sleepSync(300)
        continue
      }
      throw e
    }
  }
}

const removedFiles = new Set()

// 1. Screenshot rows: OCR queue state or crafted test ids.
const ocrRows = qa(
  `SELECT id, storagePath FROM Screenshot
   WHERE ocrStatus != 'none'
      OR id LIKE 'sc\\_%' ESCAPE '\\'
      OR id LIKE 'b\\_%' ESCAPE '\\'
      OR id LIKE 'del\\_%' ESCAPE '\\'
      OR id LIKE 'del%'
      OR id LIKE 's2\\_%' ESCAPE '\\'
      OR id LIKE 'twin\\_%' ESCAPE '\\'`
)
for (const r of ocrRows) {
  if (r.storagePath) removedFiles.add(r.storagePath)
  run('DELETE FROM Screenshot WHERE id = ?', r.id)
}

// 2. OCR test devices (hostname ocr-*) + dependents.
const ocrDevices = qa(`SELECT id FROM Device WHERE hostname LIKE 'ocr-%'`)
for (const d of ocrDevices) {
  const files = qa('SELECT storagePath FROM Screenshot WHERE deviceId = ? AND storagePath IS NOT NULL', d.id)
  for (const f of files) removedFiles.add(f.storagePath)
  run('DELETE FROM Screenshot WHERE deviceId = ?', d.id)
  run('DELETE FROM UploadTicket WHERE deviceId = ?', d.id)
  run('DELETE FROM ActivityEvent WHERE deviceId = ?', d.id)
  run('DELETE FROM DeviceHealthSnapshot WHERE deviceId = ?', d.id)
  run('DELETE FROM DeviceAssignment WHERE deviceId = ?', d.id)
  run('DELETE FROM AgentCredential WHERE deviceId = ?', d.id)
  run('DELETE FROM Device WHERE id = ?', d.id)
}

// 3. Test users.
const ocrUsers = qa(`SELECT id FROM User WHERE id LIKE 'usr\\_ocr\\_%' ESCAPE '\\' OR id LIKE 'usr\\_ocr%' ESCAPE '\\'`)
for (const u of ocrUsers) run('DELETE FROM User WHERE id = ?', u.id)

// 4. Storage files — sweep any file not referenced by a remaining row.
const keep = new Set(qa('SELECT storagePath FROM Screenshot WHERE storagePath IS NOT NULL').map((r) => r.storagePath.replaceAll('\\', '/'))) // posix rel paths in DB
function walk(dir) {
  const { readdirSync } = require('node:fs')
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(full)
    else if (ent.isFile()) {
      const rel = path.relative(STORAGE_ROOT, full).replaceAll('\\', '/')
      if (!keep.has(rel)) {
        try {
          rmSync(full, { force: true })
          removedFiles.add(rel)
        } catch {}
      }
    }
  }
}
if (existsSync(STORAGE_ROOT)) walk(STORAGE_ROOT)

const s = qa('SELECT count(*) c FROM Screenshot')[0].c
const u = qa('SELECT count(*) c FROM User')[0].c
const d = qa('SELECT count(*) c FROM Device')[0].c
const t = qa('SELECT count(*) c FROM UploadTicket')[0].c
const ocrLeft = qa(`SELECT count(*) c FROM Screenshot WHERE ocrStatus != 'none'`)[0].c
console.log(`cleanup done — Screenshot=${s} User=${u} Device=${d} Ticket=${t} ocrStatusLeft=${ocrLeft} filesRemoved=${removedFiles.size}`)
