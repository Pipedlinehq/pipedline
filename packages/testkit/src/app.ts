import { type App, type AppConfig, type Database, createApp, createDb, createPool, silentLogger, tableSecretStore } from '@ros/core';
import { type Sim, SIM_WEBHOOK_SECRET, createSimAdapters } from '@ros/adapters';
// Imported for its registrations: module catalogue, events, jobs, templates, tools.
import '@ros/modules';
import type pg from 'pg';

/** A clock tests can move. Starts at FIXTURE_NOW. */
export interface FakeClock {
  (): Date;
  set(at: Date | string): void;
  advance(ms: number): void;
  advanceMinutes(minutes: number): void;
  advanceDays(days: number): void;
}

/** Wednesday 30 September 2026, 12:00 in Sydney. Every fixture date is relative to this. */
export const FIXTURE_NOW = new Date('2026-09-30T02:00:00.000Z');

export function fakeClock(start: Date = FIXTURE_NOW): FakeClock {
  let now = start.getTime();
  const clock = (() => new Date(now)) as FakeClock;
  clock.set = (at) => void (now = new Date(at).getTime());
  clock.advance = (ms) => void (now += ms);
  clock.advanceMinutes = (m) => void (now += m * 60_000);
  clock.advanceDays = (d) => void (now += d * 86_400_000);
  return clock;
}

export const TEST_CONFIG: AppConfig = {
  tenantRootDomain: 'tables.test',
  platformHost: 'console.rosplatform.test',
  masterKey: Buffer.alloc(32, 7),
  signingKey: Buffer.alloc(32, 9),
  env: 'test',
  scheme: 'http',
  comms: {
    emailAdapter: 'sim-email',
    smsAdapter: 'sim-sms',
    platformSendingDomain: 'mail.rosplatform.test',
    platformSmsSender: 'ROS',
    webhookSecrets: { 'sim-email': SIM_WEBHOOK_SECRET, 'sim-sms': SIM_WEBHOOK_SECRET },
  },
};

export interface TestApp {
  app: App;
  db: Database;
  pool: pg.Pool;
  sim: Sim;
  clock: FakeClock;
  close(): Promise<void>;
}

/** An App wired to simulated providers and a movable clock, against the given database. */
export function createTestApp(url: string, opts: { config?: Partial<AppConfig>; clock?: FakeClock } = {}): TestApp {
  const pool = createPool(url, { max: 8 });
  const db = createDb(pool);
  const clock = opts.clock ?? fakeClock();
  const { registry, sim } = createSimAdapters({ clock });
  const app = createApp({
    db,
    config: { ...TEST_CONFIG, ...opts.config },
    adapters: registry,
    secrets: tableSecretStore,
    clock,
    log: silentLogger,
  });
  return { app, db, pool, sim, clock, close: () => db.destroy() };
}
