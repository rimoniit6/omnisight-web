// Reads a login API response from /tmp/login-ok.json and reports the fields
// relevant to the Super Admin bootstrap certification. Usage:
//   node scripts/check-login-response.mjs <path-to-json>
import { readFileSync } from 'node:fs';

const file = process.argv[2] || '/tmp/login-ok.json';
const raw = readFileSync(file, 'utf8');
let j;
try {
  j = JSON.parse(raw);
} catch {
  console.log('RAW (non-JSON):', raw.slice(0, 300));
  process.exit(1);
}
if (!j.token) {
  console.log('LOGIN FAILED:', JSON.stringify(j).slice(0, 300));
  process.exit(1);
}
const serialized = JSON.stringify(j);
console.log('token:', String(j.token).length + ' chars');
console.log('role:', j.user?.role);
console.log('org:', j.organization ? j.organization.name : 'org-less (global)');
console.log('password field leaked:', serialized.includes('"password"'));
console.log('bcrypt hash leaked:', serialized.includes('$2'));
console.log('SUPER_ADMIN_LOGIN_OK');
