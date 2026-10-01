import { z } from 'zod';
import { defineTemplate } from '../comms/templates';

/**
 * Delivery messages. All transactional: they go to whoever placed the order. Plain text; the
 * guest's own words are never in them. The tracking link is the courier service's own page.
 */

const dispatched = z.object({ first_name: z.string().max(100), venue_name: z.string(), reference: z.string(), eta_line: z.string(), tracking_url: z.string() });

export const deliveryDispatchedEmail = defineTemplate({
  key: 'delivery.dispatched',
  channel: 'email',
  kind: 'transactional',
  description: 'Sent when a courier is booked for a delivery order: the expected arrival and a link to follow the courier.',
  subject: 'Your order {{reference}} from {{venue_name}} has a courier',
  body: 'Hi {{first_name}},\n\nA courier is booked to bring your order {{reference}} from {{venue_name}}.\n{{eta_line}}\n\nFollow the delivery: {{tracking_url}}',
  variables: dispatched,
});

export const deliveryDispatchedSms = defineTemplate({
  key: 'delivery.dispatched',
  channel: 'sms',
  kind: 'transactional',
  description: 'The courier-booked notice for a guest who gave only a phone number.',
  body: '{{venue_name}}: a courier is booked for order {{reference}}. {{eta_line}} Track it: {{tracking_url}}',
  variables: dispatched,
});

const pickedUp = z.object({ first_name: z.string().max(100), venue_name: z.string(), reference: z.string(), eta_line: z.string(), tracking_url: z.string() });

export const deliveryPickedUpEmail = defineTemplate({
  key: 'delivery.picked_up',
  channel: 'email',
  kind: 'transactional',
  description: 'Sent when the courier has collected the order from the venue.',
  subject: 'Order {{reference}} is on its way',
  body: 'Hi {{first_name}},\n\nYour order {{reference}} has left {{venue_name}} with the courier.\n{{eta_line}}\n\nFollow the delivery: {{tracking_url}}',
  variables: pickedUp,
});

export const deliveryPickedUpSms = defineTemplate({
  key: 'delivery.picked_up',
  channel: 'sms',
  kind: 'transactional',
  description: 'The on-its-way notice for a guest who gave only a phone number.',
  body: '{{venue_name}}: order {{reference}} is on its way. {{eta_line}} Track it: {{tracking_url}}',
  variables: pickedUp,
});

const delivered = z.object({ first_name: z.string().max(100), venue_name: z.string(), reference: z.string() });

export const deliveryDeliveredEmail = defineTemplate({
  key: 'delivery.delivered',
  channel: 'email',
  kind: 'transactional',
  description: 'Sent when the courier service reports the order delivered.',
  subject: 'Order {{reference}} was delivered',
  body: 'Hi {{first_name}},\n\nYour order {{reference}} from {{venue_name}} has been delivered. Enjoy.\n\nIf anything is not right, reply to this email and the venue will sort it out.',
  variables: delivered,
});

export const deliveryDeliveredSms = defineTemplate({
  key: 'delivery.delivered',
  channel: 'sms',
  kind: 'transactional',
  description: 'The delivered notice for a guest who gave only a phone number.',
  body: '{{venue_name}}: order {{reference}} has been delivered. Enjoy.',
  variables: delivered,
});

const failed = z.object({ first_name: z.string().max(100), venue_name: z.string(), reference: z.string(), reason: z.string().max(300), refund_line: z.string() });

export const deliveryFailedEmail = defineTemplate({
  key: 'delivery.failed',
  channel: 'email',
  kind: 'transactional',
  description: 'Sent when a delivery failed or was returned after the courier collected it, with what the guest gets back.',
  subject: 'Order {{reference}} could not be delivered',
  body: 'Hi {{first_name}},\n\nSorry, your order {{reference}} from {{venue_name}} could not be delivered.\n\n{{reason}}\n\n{{refund_line}}',
  variables: failed,
});

export const deliveryFailedSms = defineTemplate({
  key: 'delivery.failed',
  channel: 'sms',
  kind: 'transactional',
  description: 'The failed-delivery notice for a guest who gave only a phone number.',
  body: '{{venue_name}}: sorry, order {{reference}} could not be delivered. {{reason}} {{refund_line}}',
  variables: failed,
});

const pickup = z.object({ first_name: z.string().max(100), venue_name: z.string(), reference: z.string(), where_line: z.string(), refund_line: z.string() });

export const deliveryNoCourierPickupEmail = defineTemplate({
  key: 'delivery.no_courier_pickup',
  channel: 'email',
  kind: 'transactional',
  description: 'Sent when no courier could take a delivery order and the venue offers pickup instead; the delivery fee is refunded.',
  subject: 'Order {{reference}}: no courier, ready for pickup instead',
  body: 'Hi {{first_name}},\n\nSorry, no courier is available to bring order {{reference}} from {{venue_name}}. Your food is still being made and can be collected from {{where_line}}. We will tell you when it is ready.\n\n{{refund_line}}\n\nIf you cannot collect it, reply to this email and the venue will refund the order.',
  variables: pickup,
});

export const deliveryNoCourierPickupSms = defineTemplate({
  key: 'delivery.no_courier_pickup',
  channel: 'sms',
  kind: 'transactional',
  description: 'The no-courier, collect-instead notice for a guest who gave only a phone number.',
  body: '{{venue_name}}: sorry, no courier for order {{reference}}. Collect it from {{where_line}}; we will text when ready. {{refund_line}}',
  variables: pickup,
});
