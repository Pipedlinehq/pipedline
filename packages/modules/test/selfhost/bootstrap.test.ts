import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createDb, silentLogger, tableSecretStore } from '@ros/core';
import { createSimAdapters } from '@ros/adapters';
import { auth } from '@ros/modules';
import { TEST_CONFIG } from '@ros/testkit';
import { bootstrapAdmin } from '../../../../scripts/bootstrap-admin';
import { runMigrations } from '../../../../scripts/db-migrate';

/**
 * scripts/bootstrap-admin.ts on an empty, migrated database (no fixtures): the first platform
 * admin is made once, the same call again changes nothing, and the person can then really sign in.
 */
const name = `boot_${randomBytes(4).toString('hex')}`;
const server = (database: string) => `postgres://postgres:postgres@127.0.0.1:${process.env.ROS_TEST_PG_PORT}/${database}`;
let pool: pg.Pool;

async function admin(sql: string): Promise<void> {
  const c = new pg.Client({ connectionString: server('postgres') });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

const rows = async () => (await pool.query('select u.email::text as email, u.name, pa.role from platform_admins pa join users u on u.id = pa.user_id order by pa.created_at, u.email')).rows;

beforeAll(async () => {
  await admin(`create database "${name}"`);
  pool = new pg.Pool({ connectionString: server(name), max: 4 });
});

afterAll(async () => {
  await pool.end();
  await admin(`drop database if exists "${name}" with (force)`);
});

describe('scripts/bootstrap-admin.ts', () => {
  it('refuses a database that has not been migrated', async () => {
    await expect(bootstrapAdmin(pool, { email: 'first@example.com' })).rejects.toThrow(/has not been migrated yet/);
    await runMigrations(server(name));
    expect(await rows()).toEqual([]);
  });

  it('refuses something that is not an email address, and writes nothing', async () => {
    await expect(bootstrapAdmin(pool, { email: 'not-an-address' })).rejects.toThrow(/does not look like an email address/);
    expect((await pool.query('select count(*)::int as n from users')).rows[0].n).toBe(0);
  });

  it('makes the first platform admin, and the same call again changes nothing', async () => {
    const first = await bootstrapAdmin(pool, { email: '  First@Example.com ', name: 'First Admin' });
    expect(first).toMatchObject({ email: 'first@example.com', outcome: 'created', admins: 1 });
    expect(await rows()).toEqual([{ email: 'first@example.com', name: 'First Admin', role: 'admin' }]);

    const again = await bootstrapAdmin(pool, { email: 'first@example.com', name: 'Someone Else' });
    expect(again).toEqual({ email: 'first@example.com', userId: first.userId, outcome: 'exists', admins: 1 });
    // Read back: one user, one admin, the name it was given the first time.
    expect(await rows()).toEqual([{ email: 'first@example.com', name: 'First Admin', role: 'admin' }]);
    expect((await pool.query('select count(*)::int as n from users')).rows[0].n).toBe(1);
  });

  it('two bootstraps at once make one admin', async () => {
    const results = await Promise.all([1, 2, 3].map(() => bootstrapAdmin(pool, { email: 'first@example.com' })));
    expect(results.map((r) => r.outcome)).toEqual(['exists', 'exists', 'exists']);
    expect((await rows()).length).toBe(1);
  });

  it('refuses a different address once an admin exists, unless --add', async () => {
    await expect(bootstrapAdmin(pool, { email: 'second@example.com' })).rejects.toThrow(/A platform admin already exists/);
    expect((await rows()).map((r) => r.email)).toEqual(['first@example.com']);
    // The refusal left no stray user behind.
    expect((await pool.query("select count(*)::int as n from users where email = 'second@example.com'")).rows[0].n).toBe(0);

    const added = await bootstrapAdmin(pool, { email: 'second@example.com', add: true });
    expect(added).toMatchObject({ outcome: 'created', admins: 2 });
    expect((await rows()).map((r) => r.email).sort()).toEqual(['first@example.com', 'second@example.com']);
  });

  it('promotes a person who already has a user record without making a second one', async () => {
    const existing = (await pool.query("insert into users (email, name) values ('staff@example.com', 'Sam Staff') returning id")).rows[0].id;
    const r = await bootstrapAdmin(pool, { email: 'staff@example.com', name: 'Ignored', add: true });
    expect(r.userId).toBe(existing);
    expect((await pool.query("select name from users where email = 'staff@example.com'")).rows).toEqual([{ name: 'Sam Staff' }]);
  });

  it('the admin it made can sign in to the platform console; nobody else can', async () => {
    const db = createDb(new pg.Pool({ connectionString: server(name), max: 4 }));
    const { registry, sim } = createSimAdapters({ clock: () => new Date() });
    const app = createApp({ db, config: TEST_CONFIG, adapters: registry, secrets: tableSecretStore, clock: () => new Date(), log: silentLogger });
    try {
      await auth.requestPlatformLogin(app, 'stranger@example.com');
      expect(sim.email.sent).toEqual([]);

      await auth.requestPlatformLogin(app, 'first@example.com');
      expect(sim.email.sent.map((m) => m.to)).toEqual(['first@example.com']);
      const code = sim.email.sent[0]!.body.match(/\b(\d{6})\b/)![1]!;
      const { token } = await auth.verifyPlatformLogin(app, 'first@example.com', code);
      const who = await auth.authenticate(app, token);
      expect(who?.principal).toMatchObject({ kind: 'platform' });
    } finally {
      await db.destroy();
    }
  });
});
