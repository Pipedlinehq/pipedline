import { z } from 'zod';
import { defineTemplate } from '../comms/templates';

/**
 * Order messages. All transactional: they go to whoever placed the order, whether or not they
 * agreed to marketing. Bodies are plain text; names and notes written by guests are rendered
 * as text, never markup (docs/THREAT_MODEL.md section 6).
 */

const confirmed = z.object({
  first_name: z.string().max(100),
  venue_name: z.string(),
  reference: z.string(),
  /** One line per item, already formatted. */
  summary: z.string().max(6000),
  total: z.string(),
  /** e.g. "Pickup at 6:15 pm, Wed 30 Sep" or "We will bring it to table 12." */
  when_line: z.string(),
  tracking_url: z.string(),
});

export const orderConfirmedEmail = defineTemplate({
  key: 'order.confirmed',
  channel: 'email',
  kind: 'transactional',
  description: 'Sent when an order is paid: what was ordered, the total, when it will be ready, and a link to follow it.',
  subject: 'Order {{reference}} at {{venue_name}} is confirmed',
  body: 'Hi {{first_name}},\n\nThanks for your order at {{venue_name}}.\n\n{{summary}}\n\nTotal paid: {{total}}\n{{when_line}}\n\nFollow your order: {{tracking_url}}\n\nOrder {{reference}}',
  variables: confirmed,
});

export const orderConfirmedSms = defineTemplate({
  key: 'order.confirmed',
  channel: 'sms',
  kind: 'transactional',
  description: 'The order confirmation for a guest who gave only a phone number.',
  body: '{{venue_name}}: order {{reference}} confirmed, {{total}}. {{when_line}} Follow it: {{tracking_url}}',
  variables: confirmed,
});

const ready = z.object({ first_name: z.string().max(100), venue_name: z.string(), reference: z.string(), where_line: z.string() });

export const orderReadyEmail = defineTemplate({
  key: 'order.ready',
  channel: 'email',
  kind: 'transactional',
  description: 'Sent when the kitchen marks a pickup order ready.',
  subject: 'Order {{reference}} is ready',
  body: 'Hi {{first_name}},\n\nYour order {{reference}} is ready to collect from {{venue_name}}.\n{{where_line}}',
  variables: ready,
});

export const orderReadySms = defineTemplate({
  key: 'order.ready',
  channel: 'sms',
  kind: 'transactional',
  description: 'The ready notice for a guest who gave only a phone number.',
  body: '{{venue_name}}: order {{reference}} is ready to collect. {{where_line}}',
  variables: ready,
});

const cancelled = z.object({
  first_name: z.string().max(100),
  venue_name: z.string(),
  reference: z.string(),
  reason: z.string().max(300),
  refund_line: z.string(),
});

export const orderCancelledEmail = defineTemplate({
  key: 'order.cancelled',
  channel: 'email',
  kind: 'transactional',
  description: 'Sent when the venue turns down or cancels a paid order.',
  subject: 'Order {{reference}} at {{venue_name}} was cancelled',
  body: 'Hi {{first_name}},\n\nSorry, {{venue_name}} could not complete your order {{reference}}.\n\n{{reason}}\n\n{{refund_line}}',
  variables: cancelled,
});

export const orderCancelledSms = defineTemplate({
  key: 'order.cancelled',
  channel: 'sms',
  kind: 'transactional',
  description: 'The cancellation notice for a guest who gave only a phone number.',
  body: '{{venue_name}}: sorry, order {{reference}} was cancelled. {{reason}} {{refund_line}}',
  variables: cancelled,
});

const refunded = z.object({ first_name: z.string().max(100), venue_name: z.string(), reference: z.string(), amount: z.string() });

export const orderRefundedEmail = defineTemplate({
  key: 'order.refunded',
  channel: 'email',
  kind: 'transactional',
  description: 'Sent when money for an order has gone back to the guest\'s card.',
  subject: 'A refund for order {{reference}}',
  body: 'Hi {{first_name}},\n\n{{venue_name}} has refunded {{amount}} for order {{reference}}. It goes back to the card you paid with, usually within a few business days.',
  variables: refunded,
});

export const orderRefundedSms = defineTemplate({
  key: 'order.refunded',
  channel: 'sms',
  kind: 'transactional',
  description: 'The refund notice for a guest who gave only a phone number.',
  body: '{{venue_name}}: {{amount}} refunded for order {{reference}}. It returns to your card within a few business days.',
  variables: refunded,
});

const kitchen = z.object({
  venue_name: z.string(),
  reference: z.string(),
  channel_label: z.string(),
  summary: z.string().max(6000),
  when_line: z.string(),
  /** Allergens across the order, or "none listed". A safety line: always present. */
  allergen_line: z.string(),
  /** The guest's own words, quoted. */
  note_line: z.string().max(700),
});

export const kitchenNewOrderEmail = defineTemplate({
  key: 'order.kitchen_new',
  channel: 'email',
  kind: 'transactional',
  description: 'Tells the venue\'s kitchen address about a new paid order (kitchen_routing: email).',
  subject: 'New {{channel_label}} order {{reference}}',
  body: 'New {{channel_label}} order {{reference}} at {{venue_name}}.\n\n{{summary}}\n\nAllergens: {{allergen_line}}\n{{when_line}}\n{{note_line}}',
  variables: kitchen,
});

export const kitchenNewOrderSms = defineTemplate({
  key: 'order.kitchen_new',
  channel: 'sms',
  kind: 'transactional',
  description: 'Texts the manager about a new paid order (kitchen_routing: sms).',
  body: 'New {{channel_label}} order {{reference}}. {{when_line}} Allergens: {{allergen_line}}',
  variables: kitchen,
});
