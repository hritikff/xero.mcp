// The gateway connects as teller_app, which has no UPDATE on audit_event.
// Migrations connect as the owner. Never the same role.
import pg from 'pg';

// §4.1's rule, applied to every type a driver would silently coerce.
// 1082 DATE, 1700 NUMERIC, 20 BIGINT -> keep them as strings. A date must not
// become a timezone-shifted Date, and an amount must never become a float.
for (const oid of [1082, 1700, 20]) pg.types.setTypeParser(oid, (v: string) => v);

let pool: pg.Pool | undefined;

function get(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.TELLER_DATABASE_URL;
  if (!connectionString) throw new Error('TELLER_DATABASE_URL is not set - run scripts/migrate.js');
  pool = new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }, // Supabase terminates TLS at the pooler
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return pool;
}

export const close = () => pool?.end();

export const q = <T = any>(sql: string, params: unknown[] = []) =>
  get().query<T>(sql, params).then((r) => r.rows);
