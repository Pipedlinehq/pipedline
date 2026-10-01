import { z } from 'zod';
import { defineTemplate } from '../comms/templates';

/**
 * "Here is your code." The venue is sending an offer the guest did not ask for, so this is
 * marketing: it goes through comms.queueMessage, which sends only to a guest who has agreed to
 * marketing on that channel and records everyone else as suppressed.
 */
export const OFFER_CODE_TEMPLATE = 'offers.code';

const vars = z.object({
  first_name: z.string().max(100),
  offer_name: z.string().max(120),
  /** e.g. "$10 off when you spend $40 or more". */
  offer_summary: z.string().max(300),
  code: z.string().max(40),
  claim_url: z.string().max(500),
  /** e.g. "31 October 2026". */
  expires_on: z.string().max(40),
});

export const offerCodeEmail = defineTemplate({
  key: OFFER_CODE_TEMPLATE,
  channel: 'email',
  kind: 'marketing',
  description: 'Sends a guest their own code for an offer, with the link to claim it.',
  subject: '{{offer_name}} from {{org_name}}',
  body: `Hi {{first_name}},

{{offer_summary}}.

Your code is {{code}}. It is yours alone and works once, until {{expires_on}}.

Claim it here, then show it at the counter or enter it when you order online:
{{claim_url}}`,
  variables: vars,
});

export const offerCodeSms = defineTemplate({
  key: OFFER_CODE_TEMPLATE,
  channel: 'sms',
  kind: 'marketing',
  description: 'Sends a guest their own code for an offer, with the link to claim it.',
  body: '{{org_name}}: {{offer_summary}}. Your code {{code}}, valid until {{expires_on}}. Claim it: {{claim_url}}',
  variables: vars,
});
