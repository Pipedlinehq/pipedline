import { z } from 'zod';
import { defineTemplate } from '../comms/templates';

/**
 * A message is transactional only when it confirms something the guest did. Joining is the
 * guest's own act (online, at checkout, or by giving their number at the counter), so the
 * welcome confirms it. A birthday greeting is the venue's idea, so it is marketing and goes
 * only to guests who agreed to marketing.
 */

export const WELCOME_TEMPLATE = 'loyalty.welcome';
export const BIRTHDAY_TEMPLATE = 'loyalty.birthday';

const welcomeVars = z.object({
  first_name: z.string().max(100),
  program_name: z.string().max(120),
  member_code: z.string().max(40),
  balance: z.number().int(),
  bonus_line: z.string().max(200),
  account_url: z.string().max(500),
});

export const loyaltyWelcomeEmail = defineTemplate({
  key: WELCOME_TEMPLATE,
  channel: 'email',
  kind: 'transactional',
  description: 'Confirms that the guest has joined the loyalty programme, with their member code.',
  subject: 'You have joined {{program_name}}',
  body: `Hi {{first_name}},

You have joined {{program_name}} at {{org_name}}.

Your member code is {{member_code}}. You do not need to show it to earn: whenever you pay and we know it is you (your phone number, your email, or this code), your points are added by themselves.

{{bonus_line}}
Your balance: {{balance}} points.

{{account_url}}`,
  variables: welcomeVars,
});

export const loyaltyWelcomeSms = defineTemplate({
  key: WELCOME_TEMPLATE,
  channel: 'sms',
  kind: 'transactional',
  description: 'Confirms that the guest has joined the loyalty programme, with their member code.',
  body: '{{org_name}}: you have joined {{program_name}}. Member code {{member_code}}. Points are added by themselves when you pay. {{account_url}}',
  variables: welcomeVars,
});

const birthdayVars = z.object({
  first_name: z.string().max(100),
  program_name: z.string().max(120),
  points: z.number().int(),
  account_url: z.string().max(500),
});

export const loyaltyBirthdayEmail = defineTemplate({
  key: BIRTHDAY_TEMPLATE,
  channel: 'email',
  kind: 'marketing',
  description: 'Tells a member that birthday points have been added. Marketing: sent only with the guest\'s consent.',
  subject: 'Happy birthday from {{org_name}}',
  body: `Hi {{first_name}},

Happy birthday. We have added {{points}} points to your {{program_name}} account.

{{account_url}}`,
  variables: birthdayVars,
});

export const loyaltyBirthdaySms = defineTemplate({
  key: BIRTHDAY_TEMPLATE,
  channel: 'sms',
  kind: 'marketing',
  description: 'Tells a member that birthday points have been added. Marketing: sent only with the guest\'s consent.',
  body: '{{org_name}}: happy birthday {{first_name}}. We have added {{points}} points to your {{program_name}} account. {{account_url}}',
  variables: birthdayVars,
});
