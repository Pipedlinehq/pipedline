import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

export const eventsModule = defineModule({
  key: 'events',
  name: 'Events',
  description: 'The first-party analytics stream: visitor sessions and everything guests and systems do.',
  spine: true,
  dependsOn: [],
  tables: ['events', 'visitor_sessions'],
  configSchema: z.object({}),
  configVersion: 1,
  defaultConfig: {},
});

const path = z.string().max(500);

export const sessionStarted = defineEvent({
  name: 'session.started',
  module: 'events',
  description: 'A visitor arrived on the venue\'s site or QR menu. Carries where they came from.',
  properties: z.object({ landing_path: path, referrer_host: z.string().max(200).nullable(), device_class: z.string().nullable() }),
  funnel: { name: 'order', step: 1 },
});

export const pageViewed = defineEvent({
  name: 'page.viewed',
  module: 'events',
  description: 'A page on the venue\'s site was viewed.',
  properties: z.object({ path, title: z.string().max(200).optional() }),
  client: true,
});

export const menuViewed = defineEvent({
  name: 'menu.viewed',
  module: 'events',
  description: 'The menu was opened, on the site or from a QR code.',
  properties: z.object({ surface: z.enum(['site', 'qr']), table_label: z.string().max(40).nullable().optional() }),
  client: true,
  funnel: { name: 'order', step: 2 },
});

export const itemViewed = defineEvent({
  name: 'item.viewed',
  module: 'events',
  description: 'A menu item was opened for a closer look.',
  properties: z.object({ menu_item_id: z.string().uuid(), name: z.string().max(200) }),
  client: true,
});

export const linkClicked = defineEvent({
  name: 'link.clicked',
  module: 'events',
  description: 'An outbound or call-to-action link was clicked (call, directions, booking, social).',
  properties: z.object({ kind: z.enum(['call', 'directions', 'booking', 'order', 'social', 'other']), target: z.string().max(300).optional() }),
  client: true,
});
