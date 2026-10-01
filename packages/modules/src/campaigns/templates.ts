import { z } from 'zod';
import { defineTemplate } from '../comms/templates';

/**
 * Message templates for the lifecycle flows and one-off campaigns. Every one is marketing: it
 * goes through comms.queueMessage, which sends only to a guest who agreed to marketing on that
 * channel and whose address is not suppressed, and checks both again at send time. An org may
 * override the copy of any of them (comms templates); these are the platform's working defaults.
 *
 * `offer_line` is empty when the flow has no offer, or the guest's own code in plain words.
 */
const flowVars = z.object({
  first_name: z.string().max(100),
  venue_name: z.string().max(200),
  offer_line: z.string().max(600),
});

export const FLOW_TEMPLATE_KEYS = {
  welcome: 'campaigns.welcome',
  post_purchase: 'campaigns.post_purchase',
  winback: 'campaigns.winback',
  winback_reminder: 'campaigns.winback_reminder',
  vip: 'campaigns.vip',
  birthday: 'campaigns.birthday',
} as const;

function flowPair(key: string, description: string, subject: string, emailBody: string, smsBody: string) {
  defineTemplate({ key, channel: 'email', kind: 'marketing', description, subject, body: emailBody, variables: flowVars });
  defineTemplate({ key, channel: 'sms', kind: 'marketing', description, body: smsBody, variables: flowVars });
}

flowPair(
  FLOW_TEMPLATE_KEYS.welcome,
  'Welcome: the first message after a guest agrees to hear from the venue.',
  'Welcome to {{venue_name}}',
  `Hi {{first_name}},

Thanks for joining us at {{venue_name}}. We will only write when there is something worth telling you: a new menu, a night worth booking, something just for regulars.

{{offer_line}}

See you soon.`,
  '{{org_name}}: thanks for joining us, {{first_name}}. {{offer_line}}',
);

flowPair(
  FLOW_TEMPLATE_KEYS.post_purchase,
  'Post-purchase: about three weeks after a first visit, an invitation to come back.',
  'Come back and see us, {{first_name}}',
  `Hi {{first_name}},

It has been a few weeks since your first visit to {{venue_name}}. Most of our regulars came back a second time within a couple of months; we would love you to be one of them.

{{offer_line}}`,
  '{{org_name}}: hi {{first_name}}, come back and see us at {{venue_name}}. {{offer_line}}',
);

flowPair(
  FLOW_TEMPLATE_KEYS.winback,
  'Win-back: to a guest who has not visited for a while.',
  'We have missed you, {{first_name}}',
  `Hi {{first_name}},

It has been a while since we saw you at {{venue_name}}. The menu has moved on and the table is still yours.

{{offer_line}}`,
  '{{org_name}}: we have missed you, {{first_name}}. {{offer_line}}',
);

flowPair(
  FLOW_TEMPLATE_KEYS.winback_reminder,
  'Win-back reminder: a week after the win-back, to a guest who has still not been in.',
  'Still thinking about it, {{first_name}}?',
  `Hi {{first_name}},

A quick reminder from {{venue_name}}: we would love to see you again.

{{offer_line}}`,
  '{{org_name}}: a reminder, {{first_name}}, we would love to see you again. {{offer_line}}',
);

flowPair(
  FLOW_TEMPLATE_KEYS.vip,
  'VIP: a thank-you when a guest becomes a regular.',
  'Thank you, {{first_name}}',
  `Hi {{first_name}},

You have become one of our regulars at {{venue_name}}, and we noticed. Thank you.

{{offer_line}}`,
  '{{org_name}}: thank you for being a regular, {{first_name}}. {{offer_line}}',
);

flowPair(
  FLOW_TEMPLATE_KEYS.birthday,
  'Birthday: in the week before a guest\'s birthday.',
  'Happy birthday from {{venue_name}}',
  `Hi {{first_name}},

Your birthday is coming up, and everyone at {{venue_name}} wishes you a good one.

{{offer_line}}`,
  '{{org_name}}: happy birthday, {{first_name}}! {{offer_line}}',
);

/** A one-off campaign. The subject and body are the approved copy, already personalised with the first name. */
export const CAMPAIGN_TEMPLATE_KEY = 'campaigns.campaign';
const campaignVars = z.object({ subject: z.string().max(200), body: z.string().max(5000) });

defineTemplate({
  key: CAMPAIGN_TEMPLATE_KEY,
  channel: 'email',
  kind: 'marketing',
  description: 'A one-off campaign email, written in the console or by an assistant and approved by a manager.',
  subject: '{{subject}}',
  body: '{{body}}',
  variables: campaignVars,
});
defineTemplate({
  key: CAMPAIGN_TEMPLATE_KEY,
  channel: 'sms',
  kind: 'marketing',
  description: 'A one-off campaign SMS, approved by a manager.',
  body: '{{body}}',
  variables: campaignVars,
});
