'use server';

import { redirect } from 'next/navigation';
import { campaigns } from '@ros/modules';
import type { FormState } from '@/ui/client';
import { getConsole } from '@/lib/console';
import { app } from '@/lib/runtime';
import { type DataFormState, act, actApp, int, nullableText, optText, text } from '@/lib/console-actions';

/**
 * Campaigns' server actions. The services check the role; the venue is the console's selected
 * venue, never a form field. Nothing here sends a message: sending follows an approval.
 */

const channelOf = (fd: FormData) => (text(fd, 'channel') === 'sms' ? 'sms' : 'email') as 'email' | 'sms';
const pct = (share: number) => `${Math.round(share * 100)}%`;

// ── One-off campaigns ───────────────────────────────────────────────────────

export async function saveCampaignAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = optText(fd, 'campaignId');
  const channel = channelOf(fd);
  if (id) {
    return act(
      (ctx) =>
        campaigns.updateCampaign(ctx, {
          campaignId: id,
          name: text(fd, 'name'),
          segmentId: optText(fd, 'segmentId'),
          subject: channel === 'email' ? nullableText(fd, 'subject') : undefined,
          body: text(fd, 'body'),
          offerId: nullableText(fd, 'offerId'),
        }),
      { success: (c) => `Draft saved. ${c.audienceCount ?? 0} ${c.audienceCount === 1 ? 'guest' : 'guests'} can receive it now.`, revalidate: ['/console/campaigns', `/console/campaigns/${id}`] },
    );
  }
  const r = await act(
    (ctx, c) =>
      campaigns.draftCampaign(ctx, {
        venueId: c.venue.id,
        name: text(fd, 'name'),
        channel,
        segmentId: text(fd, 'segmentId'),
        subject: channel === 'email' ? nullableText(fd, 'subject') : null,
        body: text(fd, 'body'),
        offerId: nullableText(fd, 'offerId'),
      }),
    { revalidate: '/console/campaigns' },
  );
  if (!r.ok) return r;
  redirect(`/console/campaigns/${r.data!.id}?created=1`);
}

/** How many guests a stored segment holds at the selected venue, and who can be reached. Counts only. */
export async function audienceAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const segmentId = text(fd, 'segmentId');
  if (!segmentId) return { ok: false, error: 'Choose a segment first.' };
  return act((ctx, c) => campaigns.previewSegment(ctx, { segmentId, venueId: c.venue.id }), {
    revalidate: [],
    success: (p) =>
      `${p.count.toLocaleString('en-AU')} guests in this segment call this venue home. ${p.email.reachable.toLocaleString('en-AU')} can be emailed (${pct(p.email.share)}) and ${p.sms.reachable.toLocaleString('en-AU')} can be sent an SMS (${pct(p.sms.share)}): the rest have not agreed to hear from you that way.`,
  });
}

/** Ask the model for a suggestion. It is given the venue's voice, the segment's name and size and the brief; never a guest. */
export async function suggestCopyAction(_prev: DataFormState<campaigns.CampaignCopy>, fd: FormData): Promise<DataFormState<campaigns.CampaignCopy>> {
  const c = await getConsole();
  const r = await actApp(
    () =>
      campaigns.draftCampaignCopy(app(), {
        orgId: c.session.orgId,
        principal: c.session.principal,
        input: { venueId: c.venue.id, segmentId: text(fd, 'segmentId'), channel: channelOf(fd), brief: text(fd, 'brief'), offerId: nullableText(fd, 'offerId') },
      }),
    { revalidate: [] },
  );
  if (!r.ok) return r;
  return { ok: true, message: 'A suggestion is in the message below. Read it and change it before saving: nothing has been saved or sent.', data: r.data };
}

export async function submitCampaignAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = text(fd, 'campaignId');
  return act((ctx) => campaigns.submitCampaign(ctx, { campaignId: id }), {
    success: () => 'Sent for approval. Nothing goes to guests until a manager approves it in Approvals.',
    revalidate: ['/console/campaigns', `/console/campaigns/${id}`, '/console/approvals'],
  });
}

export async function cancelCampaignAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = text(fd, 'campaignId');
  return act((ctx) => campaigns.cancelCampaign(ctx, { campaignId: id }), {
    success: 'Cancelled. No more messages will be queued for this campaign.',
    revalidate: ['/console/campaigns', `/console/campaigns/${id}`],
  });
}

// ── Segments ────────────────────────────────────────────────────────────────

function ruleFrom(fd: FormData): { ok: true; rule: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, rule: JSON.parse(text(fd, 'definition')) };
  } catch {
    return { ok: false, error: 'Add at least one condition.' };
  }
}

export async function saveSegmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const rule = ruleFrom(fd);
  if (!rule.ok) return rule;
  const id = optText(fd, 'id');
  const r = await act((ctx) => campaigns.saveSegment(ctx, { id, name: text(fd, 'name'), description: nullableText(fd, 'description'), definition: rule.rule }), {
    revalidate: ['/console/campaigns/segments', ...(id ? [`/console/campaigns/segments/${id}`] : [])],
  });
  if (!r.ok) return r;
  if (!id) redirect(`/console/campaigns/segments/${r.data!.id}?created=1`);
  return { ok: true, message: 'Segment saved.' };
}

/** Count a rule that has not been saved yet, at the selected venue. */
export async function previewRuleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const rule = ruleFrom(fd);
  if (!rule.ok) return rule;
  return act((ctx, c) => campaigns.previewSegment(ctx, { definition: rule.rule, venueId: c.venue.id }), {
    revalidate: [],
    success: (p) => `${p.count.toLocaleString('en-AU')} guests match at this venue: ${p.email.reachable.toLocaleString('en-AU')} can be emailed (${pct(p.email.share)}), ${p.sms.reachable.toLocaleString('en-AU')} can be sent an SMS (${pct(p.sms.share)}).`,
  });
}

export async function deleteSegmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const r = await act((ctx) => campaigns.deleteSegment(ctx, text(fd, 'id')), { revalidate: '/console/campaigns/segments' });
  if (!r.ok) return r;
  redirect('/console/campaigns/segments?deleted=1');
}

// ── Flows ───────────────────────────────────────────────────────────────────

type FlowKey = campaigns.FlowKey;
type Mode = 'off' | 'shadow' | 'supervised' | 'autonomous';

export async function setFlowModeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const mode = text(fd, 'mode') as Mode;
  return act((ctx) => campaigns.setFlowMode(ctx, { flowKey: text(fd, 'flowKey') as FlowKey, mode }), {
    success: (f) => `${f.name} is now set to ${mode}${f.effectiveMode !== mode ? `, and runs as ${f.effectiveMode}` : ''}.`,
    revalidate: '/console/campaigns/flows',
  });
}

export async function runFlowNowAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => campaigns.runFlowNow(ctx, { flowKey: text(fd, 'flowKey') as FlowKey }), {
    success: 'Queued. It does what its mode allows, nothing more; the result appears under “Last run” in a moment.',
    revalidate: '/console/campaigns/flows',
  });
}

export async function updateFlowAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const config: Record<string, unknown> = { channel: channelOf(fd) };
  for (const k of ['waveSize', 'dailyCap', 'staleAfterDays', 'welcomeDelayMinutes', 'postPurchaseDays', 'winbackLapsedDays', 'winbackMaxLapsedDays', 'winbackCooldownDays', 'vipOrders', 'birthdayDaysBefore']) {
    const v = int(fd, k);
    if (v !== undefined) config[k] = v;
  }
  const subject = optText(fd, 'copySubject');
  const body = optText(fd, 'copyBody');
  config.copy = { ...(subject ? { subject } : {}), ...(body ? { body } : {}) };
  return act((ctx) => campaigns.updateFlow(ctx, { flowKey: text(fd, 'flowKey') as FlowKey, config, offerId: nullableText(fd, 'offerId') }), {
    success: (f) => `${f.name} saved.`,
    revalidate: '/console/campaigns/flows',
  });
}

export async function pinFlowTemplateAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => campaigns.pinFlowTemplate(ctx, { flowKey: text(fd, 'flowKey') as FlowKey, version: text(fd, 'version') }), {
    success: (f) => `${f.name} now uses version ${f.templateVersion} (${f.steps} ${f.steps === 1 ? 'message' : 'messages'}).`,
    revalidate: '/console/campaigns/flows',
  });
}

// ── Settings ────────────────────────────────────────────────────────────────

export async function saveCampaignsSettingsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(
    (ctx) =>
      campaigns.setCampaignsSettings(ctx, {
        campaignWaveSize: int(fd, 'campaignWaveSize'),
        waveIntervalMinutes: int(fd, 'waveIntervalMinutes'),
        approvalTtlHours: int(fd, 'approvalTtlHours'),
        attributionWindowDays: int(fd, 'attributionWindowDays'),
      }),
    { success: 'Saved.', revalidate: '/console/campaigns/settings' },
  );
}
