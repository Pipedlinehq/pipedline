/**
 * First-run bootstrap for a real deployment: makes the first platform admin, by email.
 *
 *   pnpm bootstrap:admin -- --email you@example.com [--name "Your Name"]
 *   pnpm bootstrap:admin -- --email colleague@example.com --add     a further admin, later
 *
 * A platform admin signs in at https://<ROS_PLATFORM_HOST>/platform/login with a code sent to
 * that address (there is no password), and can onboard venues, see tenant health and open
 * support access. It is not a role inside any venue's organisation.
 *
 * Safe to run twice: the same address again changes nothing. Once an admin exists, a different
 * address is refused unless --add is given, so a re-run with a typo cannot quietly make a
 * second admin. Reads DATABASE_URL; the database must already be migrated (pnpm db:migrate).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';

export interface BootstrapResult {
  email: string;
  userId: string;
  /** created: this run made the admin. exists: it already was one, nothing changed. */
  outcome: 'created' | 'exists';
  /** How many platform admins there are now. */
  admins: number;
}

const emailInput = z.string().trim().toLowerCase().pipe(z.email('That does not look like an email address.').max(254));

export async function bootstrapAdmin(pool: pg.Pool, args: { email: string; name?: string | null; add?: boolean }): Promise<BootstrapResult> {
  const parsed = emailInput.safeParse(args.email);
  if (!parsed.success) throw new Error(parsed.error.issues[0]!.message);
  const email = parsed.data;

  const ready = await pool.query<{ t: string | null }>("select to_regclass('public.platform_admins')::text as t");
  if (!ready.rows[0]?.t) throw new Error('This database has not been migrated yet. Run: pnpm db:migrate');

  const client = await pool.connect();
  try {
    await client.query('begin');
    // Two bootstraps at once must not both believe they are first.
    await client.query("select pg_advisory_xact_lock(hashtext('bootstrap:platform-admin'))");
    const already = await client.query<{ id: string }>('select u.id from platform_admins pa join users u on u.id = pa.user_id where u.email = $1', [email]);
    const count = async () => Number((await client.query<{ n: string }>('select count(*) as n from platform_admins')).rows[0]!.n);
    if (already.rows[0]) {
      const admins = await count();
      await client.query('commit');
      return { email, userId: already.rows[0].id, outcome: 'exists', admins };
    }
    if ((await count()) > 0 && !args.add) {
      throw new Error('A platform admin already exists, and it is not this address. To add another admin, run again with --add.');
    }
    // A person may already exist as a user (staff at a venue) before becoming a platform admin.
    const user = await client.query<{ id: string }>(
      'insert into users (email, name) values ($1, $2) on conflict (email) do update set name = coalesce(users.name, excluded.name) returning id',
      [email, args.name?.trim() || null],
    );
    const userId = user.rows[0]!.id;
    await client.query('insert into platform_admins (user_id) values ($1) on conflict (user_id) do nothing', [userId]);
    const admins = await count();
    await client.query('commit');
    return { email, userId, outcome: 'created', admins };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invokedDirectly) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const url = process.env.DATABASE_URL;
  const email = arg('email');
  if (!url || !email) {
    console.error(!url ? 'DATABASE_URL is not set.' : 'Say who the admin is:  pnpm bootstrap:admin -- --email you@example.com');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 10_000 });
  try {
    const r = await bootstrapAdmin(pool, { email, name: arg('name'), add: process.argv.includes('--add') });
    console.log(r.outcome === 'created' ? `${r.email} is now a platform admin (${r.admins} in total).` : `${r.email} is already a platform admin. Nothing changed (${r.admins} in total).`);
    console.log('They sign in at /platform/login on the platform host, with a code emailed to that address.');
  } catch (e) {
    console.error(`Not done: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
