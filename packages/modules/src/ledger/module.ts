import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

export const ledgerModule = defineModule({
  key: 'ledger',
  name: 'Ledger',
  description: 'The append-only record of what was sold: transactions, their lines, and attribution.',
  spine: true,
  dependsOn: ['identity'],
  tables: ['transactions', 'transaction_lines', 'transaction_attributions', 'ingest_cursors'],
  configSchema: z.object({}),
  configVersion: 1,
  defaultConfig: {},
});

export const transactionRecorded = defineEvent({
  name: 'transaction.recorded',
  module: 'ledger',
  description: 'A sale entered the ledger, from the POS, an online order, or another source.',
  properties: z.object({
    transaction_id: z.string(),
    source: z.string(),
    channel: z.string(),
    total_cents: z.number().int(),
    identified: z.boolean().describe('Whether the sale is tied to a known customer'),
  }),
});

export const transactionRefunded = defineEvent({
  name: 'transaction.refunded',
  module: 'ledger',
  description: 'A sale already in the ledger was refunded in full or in part.',
  properties: z.object({ transaction_id: z.string(), refunded_cents: z.number().int(), full: z.boolean() }),
});
