import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

/**
 * Config surface: docs/modules/qr.md section 8. `qr_enabled` is the module switch itself.
 * Extend this schema; never hardcode a venue's choice.
 */
export const qrConfig = z.object({
  /** view = the live menu only (Q1). order = order and pay from the table (Q2); needs ordering switched on. */
  stage: z
    .enum(['view', 'order'])
    .default('view')
    .describe('What scanning a code opens. "view": the live menu only. "order": guests order and pay from the table, which needs Online ordering switched on. Default "view".'),
  /** Staff bring the drink and make the call: keep alcohol out of orders placed from a phone. */
  exclude_alcohol: z
    .boolean()
    .default(false)
    .describe('Keep alcohol off orders placed from a phone at the table, so staff bring drinks and make the call in person. Default off.'),
  /** Only a table or counter code may order; the general menu code is view-only. */
  require_table: z
    .boolean()
    .default(true)
    .describe('Only a code printed for a table or the counter may be used to order; the general menu code stays view-only. Default on.'),
  tipping_enabled: z.boolean().default(false).describe('Whether guests ordering from the table are offered a tip at checkout. Default off.'),
  /** Percentages offered at checkout. */
  tip_presets: z
    .array(z.number().int().min(0).max(100).describe('One tip choice, as a percentage of the order (0 to 100).'))
    .max(6)
    .default([5, 10, 15])
    .describe('The tip choices offered at the table checkout, as percentages of the order. Up to six. Default 5, 10 and 15.'),
  /** A table's session closes after this long with no order. The next order opens a new one. */
  session_idle_minutes: z
    .number()
    .int()
    .min(5)
    .max(720)
    .default(120)
    .describe('A table\'s rounds are grouped together until this many minutes pass with no new order from it. The next order after that starts a fresh group. Default 120.'),
  show_prices: z.boolean().default(true).describe('Whether the menu opened from a QR code shows prices. Default on.'),
  /** Which optional boxes the table checkout offers (docs/modules/qr.md section 6). */
  receipt_email_prompt: z
    .boolean()
    .default(true)
    .describe('Offer guests an unticked box at the table checkout to have their receipt emailed to them. Ticking it is not a yes to marketing. Default on.'),
  loyalty_prompt: z
    .boolean()
    .default(true)
    .describe('Offer guests an unticked box at the table checkout to join the loyalty programme. Default on.'),
});
export type QrConfig = z.infer<typeof qrConfig>;

export const qrModule = defineModule({
  key: 'qr',
  name: 'QR menu and table ordering',
  description: 'Dynamic QR codes, the table context, table sessions.',
  // Ordering is needed only at stage "order", and is checked there: a view-only QR menu works without it.
  dependsOn: [],
  manifest: {
    name: 'QR menu and table ordering',
    purpose: 'A QR code on each table opens the live menu on the guest\'s phone; with Online ordering on, guests order and pay from the table and each table\'s rounds are grouped.',
    category: 'channels',
    kind: 'channel',
    needs: ['A menu', 'To order and pay from the table (stage "order"): Online ordering switched on and a payment account connected'],
    reads: ['the menu', 'online ordering settings'],
    writes: ['QR codes and their scans', 'table sessions'],
    publicAddress: ({ siteOrigin }) => (siteOrigin ? `${siteOrigin}/q/<code>` : null),
  },
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
