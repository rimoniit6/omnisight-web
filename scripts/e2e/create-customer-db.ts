import 'dotenv/config';
import { Client } from 'pg';

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const roles = await c.query(`SELECT rolname, rolsuper, rolcreatedb FROM pg_roles WHERE rolname = current_user`);
  console.log('current_user =>', JSON.stringify(roles.rows[0]));

  const exists = await c.query(`SELECT count(*)::int AS n FROM pg_database WHERE datname='omnisight_e2e_customer'`);
  if (exists.rows[0].n === 0) {
    try {
      await c.query(`CREATE DATABASE omnisight_e2e_customer`);
      console.log('CREATED omnisight_e2e_customer');
    } catch (e) {
      console.log('CREATE failed:', (e as Error).message);
    }
  } else {
    console.log('omnisight_e2e_customer already exists');
  }
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});