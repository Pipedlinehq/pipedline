'use server';

import { comms } from '@ros/modules';
import type { FormState } from '@/ui/client';
import { act, bool, text } from '@/lib/console-actions';

/** Alerts to the team. The services check the role at the venue; the venue is the console's, never the form's. */
const PATH = '/console/settings/notifications';

export async function setAlertRuleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const event = text(fd, 'event') as comms.AlertEvent;
  const channel = text(fd, 'channel') as comms.AlertChannel;
  const who = text(fd, 'recipient');
  if (!who) return { ok: false, error: 'Choose who is told.' };
  const recipient = who.startsWith('role:') ? ({ kind: 'role', role: who.slice(5) } as const) : ({ kind: 'staff', staffId: who.replace(/^staff:/, '') } as const);
  return act((ctx, c) => comms.setAlertRule(ctx, { venueId: c.venue.id, event, channel, recipient: recipient as comms.SetAlertRuleInput['recipient'], enabled: true }), {
    success: (r) => `${comms.ALERT_EVENT_DEFS[r.event].label}: ${r.channel === 'sms' ? 'a text' : 'an email'} to ${r.recipient.kind === 'staff' ? r.recipient.name : `every ${comms.ROLE_WORDS[r.recipient.role].toLowerCase()}`}.`,
    revalidate: [PATH, '/console'],
  });
}

export async function toggleAlertRuleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const event = text(fd, 'event') as comms.AlertEvent;
  const channel = text(fd, 'channel') as comms.AlertChannel;
  const kind = text(fd, 'recipientKind');
  const recipient = kind === 'role' ? ({ kind: 'role', role: text(fd, 'recipient') } as const) : ({ kind: 'staff', staffId: text(fd, 'recipient') } as const);
  const enabled = bool(fd, 'enabled');
  return act((ctx, c) => comms.setAlertRule(ctx, { venueId: c.venue.id, event, channel, recipient: recipient as comms.SetAlertRuleInput['recipient'], enabled }), {
    success: enabled ? 'Switched on.' : 'Switched off. The rule stays here, so it can be switched back on.',
    revalidate: [PATH],
  });
}

export async function removeAlertRuleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => comms.removeAlertRule(ctx, text(fd, 'id')), { success: 'Removed.', revalidate: [PATH] });
}

export async function sendTestAlertAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => comms.sendTestAlert(ctx, { ruleId: text(fd, 'id') }), {
    success: (r) => (r.queued ? `Test sent to ${r.queued} ${r.queued === 1 ? 'person' : 'people'}. It arrives the way a real alert would.` : 'Nobody could be reached: check the recipient has an address for this channel.'),
    revalidate: [],
  });
}

export async function saveAlertSettingsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const on = bool(fd, 'quietOn');
  const start = text(fd, 'quietStart');
  const end = text(fd, 'quietEnd');
  const hour = Number(text(fd, 'dailyDigestHour'));
  return act((ctx) => comms.setAlertSettings(ctx, { quietHours: on ? { start, end } : null, ...(Number.isInteger(hour) ? { dailyDigestHour: hour } : {}) }), {
    success: on ? `Saved. Alerts that are not urgent wait from ${start} to ${end}, venue time.` : 'Saved. No quiet hours: every alert goes at once.',
    revalidate: [PATH],
  });
}
