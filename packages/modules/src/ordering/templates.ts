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

// ── Didn't finish: the one nudge (pattern 7). Transactional: about the guest's own order, no marketing. ──

const nudge = z.object({
  first_name: z.string().max(100),
  venue_name: z.string(),
  reference: z.string(),
  /** One line per item, names only. */
  summary: z.string().max(6000),
  total: z.string(),
  /** "Finish paying here: <link>" while the order can still be paid, or "Order again at <link>" once it has lapsed. */
  resume_line: z.string(),
});

export const orderNudgeEmail = defineTemplate({
  key: 'order.nudge',
  channel: 'email',
  kind: 'transactional',
  description: 'The one nudge staff may send about an order a guest started but did not pay for: what was in it and where to finish or start again. Never a second one, never an offer.',
  subject: 'Your order at {{venue_name}} was not finished',
  body: 'Hi {{first_name}},\n\nYou started an order at {{venue_name}} but it was not paid, so nothing went to the kitchen.\n\n{{summary}}\n\nTotal: {{total}}\n\n{{resume_line}}\n\nIf you did not mean to order, there is nothing to do.\n\nOrder {{reference}}',
  variables: nudge,
});

export const orderNudgeSms = defineTemplate({
  key: 'order.nudge',
  channel: 'sms',
  kind: 'transactional',
  description: 'The nudge about an unfinished order, for a guest who gave only a phone number.',
  body: '{{venue_name}}: your order {{reference}} ({{total}}) was not paid, so nothing went to the kitchen. {{resume_line}}',
  variables: nudge,
});

// ── Phone and function orders: the pay link (pattern 10). ──

const payLink = z.object({
  first_name: z.string().max(100),
  venue_name: z.string(),
  reference: z.string(),
  summary: z.string().max(6000),
  total: z.string(),
  /** e.g. "Pickup at 6:15 pm, Sat 10 Oct" or "For your function on Sat 10 Oct". */
  when_line: z.string(),
  pay_url: z.string(),
  /** "The link works until Fri 9 Oct." or empty. */
  hold_line: z.string(),
});

export const payLinkEmail = defineTemplate({
  key: 'order.pay_link',
  channel: 'email',
  kind: 'transactional',
  description: 'Sent when staff send the guest a link to pay for a phone or function order: what is in it, the total, and the venue\'s own page to pay on.',
  subject: 'Pay for your order {{reference}} at {{venue_name}}',
  body: 'Hi {{first_name}},\n\nHere is your order from {{venue_name}}, ready to pay.\n\n{{summary}}\n\nTotal: {{total}}\n{{when_line}}\n\nPay here: {{pay_url}}\n{{hold_line}}\n\nOrder {{reference}}',
  variables: payLink,
});

export const payLinkSms = defineTemplate({
  key: 'order.pay_link',
  channel: 'sms',
  kind: 'transactional',
  description: 'The pay link for a guest who gave only a phone number.',
  body: '{{venue_name}}: your order {{reference}} comes to {{total}}. {{when_line}} Pay here: {{pay_url}} {{hold_line}}',
  variables: payLink,
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
  /** The offers that came off and the surcharges that went on, one per line with the figure, then each surcharge's legal line; empty when there are none. */
  charges_line: z.string().max(2000).default(''),
});

export const kitchenNewOrderEmail = defineTemplate({
  key: 'order.kitchen_new',
  channel: 'email',
  kind: 'transactional',
  description: 'Tells the venue\'s kitchen address about a new paid order (kitchen_routing: email).',
  subject: 'New {{channel_label}} order {{reference}}',
  body: 'New {{channel_label}} order {{reference}} at {{venue_name}}.\n\n{{summary}}\n\nAllergens: {{allergen_line}}\n{{when_line}}\n{{note_line}}\n{{charges_line}}',
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
