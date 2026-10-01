import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

/**
 * Config surface: docs/modules/qr.md section 8. `qr_enabled` is the module switch itself.
 * Extend this schema; never hardcode a venue's choice.
 */
export const qrConfig = z.object({
  /** view = the live menu only (Q1). order = order and pay from the table (Q2); needs ordering switched on. */
  stage: z.enum(['view', 'order']).default('view'),
  /** Staff bring the drink and make the call: keep alcohol out of orders placed from a phone. */
  exclude_alcohol: z.boolean().default(false),
  /** Only a table or counter code may order; the general menu code is view-only. */
  require_table: z.boolean().default(true),
  tipping_enabled: z.boolean().default(false),
  /** Percentages offered at checkout. */
  tip_presets: z.array(z.number().int().min(0).max(100)).max(6).default([5, 10, 15]),
  /** A table's session closes after this long with no order. The next order opens a new one. */
  session_idle_minutes: z.number().int().min(5).max(720).default(120),
  show_prices: z.boolean().default(true),
  /** Which optional boxes the table checkout offers (docs/modules/qr.md section 6). */
  receipt_email_prompt: z.boolean().default(true),
  loyalty_prompt: z.boolean().default(true),
});
export type QrConfig = z.infer<typeof qrConfig>;

export const qrModule = defineModule({
  key: 'qr',
  name: 'QR menu and table ordering',
  description: 'Dynamic QR codes, the table context, table sessions.',
  // Ordering is needed only at stage "order", and is checked there: a view-only QR menu works without it.
  dependsOn: [],
  needs: ['A menu', 'To order and pay from the table (stage "order"): Online ordering switched on and a payment account connected'],
  tables: ['qr_codes', 'table_sessions'],
  configSchema: qrConfig,
  configVersion: 1,
  defaultConfig: qrConfig.parse({}),
});

export const qrScanned = defineEvent({
  name: 'qr.scanned',
  module: 'qr',
  description: 'A guest scanned one of the venue\'s QR codes. Carries the table and the kind of code, before anyone orders.',
  properties: z.object({
    qr_code_id: z.string(),
    kind: z.enum(['menu', 'table', 'counter', 'campaign']),
    table_label: z.string().nullable(),
    area: z.string().nullable(),
  }),
});

export const tableSessionOpened = defineEvent({
  name: 'table_session.opened',
  module: 'qr',
  description: 'A table placed its first order: its rounds are grouped from here.',
  properties: z.object({ table_session_id: z.string(), table_label: z.string() }),
});

export const tableSessionClosed = defineEvent({
  name: 'table_session.closed',
  module: 'qr',
  description: 'A table\'s session ended: nobody ordered for a while, or staff closed it.',
  properties: z.object({ table_session_id: z.string(), table_label: z.string(), reason: z.enum(['idle', 'staff']), minutes_open: z.number().int() }),
});
