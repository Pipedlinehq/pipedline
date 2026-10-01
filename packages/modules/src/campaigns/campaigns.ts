import { z } from 'zod';
import { type Ctx, AppError, assertModule, audit, conflict, defineJob, enqueue, forbidden, invalid, json, notFound, requireStaff, sql, staffOf, track, visibleVenueIds } from '@ros/core';
import { type Approval, requestApproval } from '../approvals/index';
import { queueMessage } from '../comms/outbox';
import { getOffer } from '../offers/definitions';
import { getVenue } from '../tenancy/venues';
import { campaignDrafted, campaignSent, campaignSubmitted, campaignWaveQueued, campaignsModule } from './module';
import { type SegmentPreview, audienceWhere, compileFrame, countAudience, loadSegment, reachableSql } from './segments';
import { getCampaignsSettings } from './settings';
import { CAMPAIGN_TEMPLATE_KEY } from './templates';
import { offerLineFor } from './flows';

/**
 * One-off campaigns: drafted by staff or an assistant, sent only with a manager's approval
 * through the approvals queue, then queued in waves so a cold list warms up (one venue we measured: one email in
 * a year to 8,000 subscribers; the fix is waves, not one blast).
 *
 *   draft → pending_approval → approved → sending → sent        (cancelled from any of the first four)
 *   a rejected or lapsed approval returns the campaign to draft; nothing is sent
 *
 * A campaign belongs to one venue and goes to the segment's guests whose home venue it is. The
 * audience is counted at draft, at submission and again when the first wave goes.
 */

export type CampaignStatus = 'draft' | 'pending_approval' | 'approved' | 'scheduled' | 'sending' | 'sent' | 'cancelled';

export interface CampaignView {
  id: string;
  venueId: string;
  name: string;
  channel: 'email' | 'sms';
  segmentId: string | null;
  segmentName: string | null;
  subject: string | null;
  body: string | null;
  offerId: string | null;
  status: CampaignStatus;
  audienceCount: number | null;
  stats: Record<string, unknown>;
  createdByKind: string;
  approvedByStaffId: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLS = ['id', 'venue_id', 'name', 'channel', 'segment_id', 'subject', 'body', 'offer_id', 'status', 'audience_count', 'stats', 'created_by_kind', 'approved_by_staff_id', 'sent_at', 'created_at', 'updated_at'] as const;
type Row = {
  id: string;
  venue_id: string | null;
  name: string;
  channel: 'email' | 'sms';
  segment_id: string | null;
  subject: string | null;
  body: string | null;
  offer_id: string | null;
  status: CampaignStatus;
  audience_count: number | null;
  stats: unknown;
  created_by_kind: string;
  approved_by_staff_id: string | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

async function view(ctx: Ctx, r: Row): Promise<CampaignView> {
  const seg = r.segment_id ? await ctx.db.selectFrom('segments').select('name').where('id', '=', r.segment_id).executeTakeFirst() : null;
  return {
    id: r.id,
    venueId: r.venue_id!,
    name: r.name,
    channel: r.channel,
    segmentId: r.segment_id,
    segmentName: seg?.name ?? null,
    subject: r.subject,
    body: r.body,
    offerId: r.offer_id,
    status: r.status,
    audienceCount: r.audience_count,
    stats: (r.stats ?? {}) as Record<string, unknown>,
    createdByKind: r.created_by_kind,
    approvedByStaffId: r.approved_by_staff_id,
    sentAt: r.sent_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** A campaign the caller may see: another org's, or one at a venue they have no role at, is not found. */
async function loadCampaign(ctx: Ctx, id: string, opts: { minRole?: 'read_only' | 'manager'; lock?: boolean } = {}): Promise<Row> {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw notFound('Campaign not found');
  let q = ctx.db.selectFrom('campaigns').select(COLS).where('id', '=', parsed.data);
  if (opts.lock) q = q.forUpdate();
  const r = (await q.executeTakeFirst()) as Row | undefined;
  if (!r || !r.venue_id) throw notFound('Campaign not found');
  requireStaff(ctx, { venueId: r.venue_id, minRole: opts.minRole ?? 'manager' });
  await assertModule(ctx, r.venue_id, campaignsModule);
  return r;
}

/** Only guest-safe text: plain copy, rendered as text by comms, never markup. */
const copyText = (max: number) => z.string().trim().min(1).max(max);

export const draftCampaignInput = z
  .object({
    venueId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    channel: z.enum(['email', 'sms']),
    segmentId: z.string().uuid(),
    /** Email only. */
    subject: copyText(200).nullish(),
    /** {{first_name}} is filled in per guest. The guest's own code, when there is an offer, is added below it. */
    body: copyText(5000),
    offerId: z.string().uuid().nullish(),
  })
  .superRefine((v, c) => {
    if (v.channel === 'email' && !v.subject) c.addIssue({ code: 'custom', message: 'An email needs a subject.', path: ['subject'] });
    if (v.channel === 'sms' && v.body.length > 480) c.addIssue({ code: 'custom', message: 'Keep an SMS under 480 characters.', path: ['body'] });
  });

async function checkOffer(ctx: Ctx, offerId: string | null | undefined): Promise<void> {
  if (!offerId) return;
  const offer = await getOffer(ctx, offerId);
  if (!offer.isActive) throw invalid('That offer is switched off.');
}

async function audienceOf(ctx: Ctx, r: Pick<Row, 'segment_id' | 'venue_id' | 'channel'>): Promise<{ preview: SegmentPreview; reachable: number }> {
  if (!r.segment_id) return { preview: { count: 0, email: { reachable: 0, share: 0 }, sms: { reachable: 0, share: 0 } }, reachable: 0 };
  const seg = await loadSegment(ctx, r.segment_id);
  const preview = await countAudience(ctx, { rule: seg.definition, venueId: r.venue_id });
  return { preview, reachable: r.channel === 'email' ? preview.email.reachable : preview.sms.reachable };
}

/**
 * Draft a campaign. A manager at the venue, in the console or through their assistant. A draft
 * sends nothing; `audience_count` is how many guests of the segment can receive it now.
 */
export async function draftCampaign(ctx: Ctx, raw: z.input<typeof draftCampaignInput>): Promise<CampaignView> {
  const parsed = draftCampaignInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That campaign is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  await assertModule(ctx, input.venueId, campaignsModule);
  await loadSegment(ctx, input.segmentId);
  await checkOffer(ctx, input.offerId);
  const { reachable } = await audienceOf(ctx, { segment_id: input.segmentId, venue_id: input.venueId, channel: input.channel });
  const by = ctx.principal.kind === 'agent' ? 'agent' : 'staff';
  const staff = staffOf(ctx);
  const r = (await ctx.db
    .insertInto('campaigns')
    .values({
      org_id: ctx.orgId,
      venue_id: input.venueId,
      name: input.name,
      channel: input.channel,
      segment_id: input.segmentId,
      template_key: CAMPAIGN_TEMPLATE_KEY,
      subject: input.channel === 'email' ? (input.subject ?? null) : null,
      body: input.body,
      offer_id: input.offerId ?? null,
      status: 'draft',
      audience_count: reachable,
      created_by_kind: by,
      created_by_id: ctx.principal.kind === 'agent' ? ctx.principal.keyId : (staff?.staffId ?? null),
      created_at: ctx.now(),
      updated_at: ctx.now(),
    })
    .returning(COLS)
    .executeTakeFirstOrThrow()) as Row;
  await audit(ctx, { action: 'campaign.drafted', entityType: 'campaign', entityId: r.id, venueId: input.venueId, after: { name: r.name, channel: r.channel, segmentId: r.segment_id, offerId: r.offer_id, by } });
  await track(ctx, campaignDrafted, { campaign_id: r.id, channel: r.channel, by, audience_count: reachable }, { venueId: input.venueId, source: by === 'agent' ? 'agent' : 'server' });
  return view(ctx, r);
}

export const updateCampaignInput = z.object({
  campaignId: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  segmentId: z.string().uuid().optional(),
  subject: copyText(200).nullish(),
  body: copyText(5000).optional(),
  offerId: z.string().uuid().nullish(),
});

/** Change a draft. Once it has gone to a manager it is locked; cancel the request to change it. */
export async function updateCampaign(ctx: Ctx, raw: z.input<typeof updateCampaignInput>): Promise<CampaignView> {
  const parsed = updateCampaignInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That change is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  const r = await loadCampaign(ctx, input.campaignId, { lock: true });
  if (r.status !== 'draft') throw conflict('Only a draft can be changed.');
  if (input.segmentId) await loadSegment(ctx, input.segmentId);
  if (input.offerId) await checkOffer(ctx, input.offerId);
  const next = {
    name: input.name ?? r.name,
    segment_id: input.segmentId ?? r.segment_id,
    subject: r.channel === 'email' ? (input.subject !== undefined ? input.subject : r.subject) : null,
    body: input.body ?? r.body,
    offer_id: input.offerId !== undefined ? (input.offerId ?? null) : r.offer_id,
  };
  if (r.channel === 'email' && !next.subject) throw invalid('An email needs a subject.');
  const { reachable } = await audienceOf(ctx, { segment_id: next.segment_id, venue_id: r.venue_id, channel: r.channel });
  const updated = (await ctx.db
    .updateTable('campaigns')
    .set({ ...next, audience_count: reachable, updated_at: ctx.now() })
    .where('id', '=', r.id)
    .returning(COLS)
    .executeTakeFirstOrThrow()) as Row;
  await audit(ctx, { action: 'campaign.updated', entityType: 'campaign', entityId: r.id, venueId: r.venue_id, before: { name: r.name, segmentId: r.segment_id, subject: r.subject, body: r.body, offerId: r.offer_id }, after: next });
  return view(ctx, updated);
}

export const CAMPAIGN_SEND_APPROVAL = 'campaigns.campaign_send';

/**
 * Ask a manager to approve sending. Staff only: an assistant can draft a campaign, never put it
 * on its way. The approval states exactly what will go, to how many, from where.
 */
export async function submitCampaign(ctx: Ctx, raw: { campaignId: string }): Promise<{ campaign: CampaignView; approval: Approval }> {
  const input = z.object({ campaignId: z.string().uuid() }).parse(raw);
  if (ctx.principal.kind === 'agent') throw forbidden('An assistant can draft a campaign; a person sends it for approval in the console.');
  const r = await loadCampaign(ctx, input.campaignId, { lock: true });
  if (r.status !== 'draft') throw conflict(r.status === 'pending_approval' ? 'That campaign is already waiting for approval.' : 'Only a draft can be sent for approval.');
  if (!r.segment_id || !r.body) throw invalid('Choose a segment and write the message first.');
  const { reachable } = await audienceOf(ctx, r);
  if (!reachable) throw invalid('Nobody in that segment can receive this yet: no guest there has agreed to hear from you on this channel.');
  const settings = await getCampaignsSettings(ctx);
  const venue = await getVenue(ctx, r.venue_id!);
  const seg = await loadSegment(ctx, r.segment_id);
  const offer = r.offer_id ? await getOffer(ctx, r.offer_id) : null;
  const waves = Math.ceil(reachable / settings.campaignWaveSize);
  const approval = await requestApproval(ctx, {
    kind: CAMPAIGN_SEND_APPROVAL,
    subjectType: 'campaign',
    subjectId: r.id,
    venueId: r.venue_id,
    summary:
      `Send "${r.name}" by ${r.channel === 'email' ? 'email' : 'SMS'} from ${venue.name} to the ${reachable} ${reachable === 1 ? 'guest' : 'guests'} in "${seg.name}" who have agreed to hear from you` +
      `${offer ? `, each with their own code (${offer.summary})` : ''}` +
      `${waves > 1 ? `, in ${waves} waves of up to ${settings.campaignWaveSize}, ${settings.waveIntervalMinutes} minutes apart` : ''}. Anyone who opts out before their message goes is skipped.`,
    payload: { campaignId: r.id, channel: r.channel, subject: r.subject, body: r.body, segment: seg.name, audienceCount: reachable, offer: offer?.summary ?? null },
    expiresAt: new Date(ctx.now().getTime() + settings.approvalTtlHours * 3_600_000),
  });
  const updated = (await ctx.db
    .updateTable('campaigns')
    .set({ status: 'pending_approval', audience_count: reachable, updated_at: ctx.now() })
    .where('id', '=', r.id)
    .returning(COLS)
    .executeTakeFirstOrThrow()) as Row;
  await audit(ctx, { action: 'campaign.submitted', entityType: 'campaign', entityId: r.id, venueId: r.venue_id, after: { approvalId: approval.id, audienceCount: reachable } });
  await track(ctx, campaignSubmitted, { campaign_id: r.id, approval_id: approval.id, audience_count: reachable }, { venueId: r.venue_id });
  return { campaign: await view(ctx, updated), approval };
}

/** Stop a campaign that has not finished. What has already been queued stays queued; nothing more goes. */
export async function cancelCampaign(ctx: Ctx, raw: { campaignId: string }): Promise<CampaignView> {
  const input = z.object({ campaignId: z.string().uuid() }).parse(raw);
  const r = await loadCampaign(ctx, input.campaignId, { lock: true });
  if (r.status === 'sent' || r.status === 'cancelled') throw conflict(`That campaign is already ${r.status}.`);
  if (r.status === 'pending_approval') {
    // The waiting approval can no longer be acted on: the handler finds the campaign cancelled.
  }
  const updated = (await ctx.db.updateTable('campaigns').set({ status: 'cancelled', updated_at: ctx.now() }).where('id', '=', r.id).returning(COLS).executeTakeFirstOrThrow()) as Row;
  await audit(ctx, { action: 'campaign.cancelled', entityType: 'campaign', entityId: r.id, venueId: r.venue_id, before: { status: r.status }, after: { status: 'cancelled' } });
  return view(ctx, updated);
}

export async function getCampaign(ctx: Ctx, id: string): Promise<CampaignView> {
  return view(ctx, await loadCampaign(ctx, id, { minRole: 'read_only' }));
}

export const listCampaignsInput = z.object({
  venueId: z.string().uuid().optional(),
  status: z.enum(['draft', 'pending_approval', 'approved', 'scheduled', 'sending', 'sent', 'cancelled']).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export async function listCampaigns(ctx: Ctx, raw: z.input<typeof listCampaignsInput> = {}): Promise<CampaignView[]> {
  const input = listCampaignsInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'read_only' });
  if (input.venueId) await assertModule(ctx, input.venueId, campaignsModule);
  const visible = visibleVenueIds(ctx);
  let q = ctx.db.selectFrom('campaigns').select(COLS).orderBy('created_at', 'desc').limit(input.limit);
  if (input.venueId) q = q.where('venue_id', '=', input.venueId);
  else if (visible) q = visible.length ? q.where('venue_id', 'in', visible) : q.where(sql<boolean>`false`);
  if (input.status) q = q.where('status', '=', input.status);
  const out: CampaignView[] = [];
  for (const r of (await q.execute()) as Row[]) out.push(await view(ctx, r));
  return out;
}

// ── Approval → send, in waves ───────────────────────────────────────────────

/** The approval handler's work, in the deciding transaction: approved queues the first wave; anything else back to draft. */
export async function onCampaignDecision(ctx: Ctx, approval: Approval, decision: 'approved' | 'rejected' | 'expired'): Promise<void> {
  const r = (await ctx.db.selectFrom('campaigns').select(COLS).where('id', '=', approval.subjectId).forUpdate().executeTakeFirst()) as Row | undefined;
  if (!r || r.status !== 'pending_approval') return;
  if (decision === 'approved') {
    await ctx.db.updateTable('campaigns').set({ status: 'approved', approved_by_staff_id: approval.decidedByStaffId, updated_at: ctx.now() }).where('id', '=', r.id).execute();
    await enqueue(ctx, campaignSendJob, { campaignId: r.id, wave: 1 }, { key: `campaign:${r.id}:w1` });
  } else {
    await ctx.db.updateTable('campaigns').set({ status: 'draft', updated_at: ctx.now() }).where('id', '=', r.id).execute();
  }
  await audit(ctx, { action: `campaign.${decision}`, entityType: 'campaign', entityId: r.id, venueId: r.venue_id, after: { approvalId: approval.id } });
}

/** Fill {{first_name}} in the approved copy. Nothing else in it is a variable. */
const personalise = (text: string, firstName: string) => text.replace(/\{\{\s*first_name\s*\}\}/g, firstName);

/**
 * One wave: recount the audience (on the first wave, recorded as audience_count), pick the next
 * guests not yet messaged for this campaign, issue their codes, queue their messages. Then either
 * schedule the next wave or mark the campaign sent. Safe to run twice: a guest's message key is
 * the campaign and the guest.
 */
export async function sendCampaignWave(ctx: Ctx, campaignId: string, wave: number): Promise<{ queued: number; suppressed: number; remaining: number }> {
  const r = (await ctx.db.selectFrom('campaigns').select(COLS).where('id', '=', campaignId).forUpdate().executeTakeFirst()) as Row | undefined;
  if (!r || (r.status !== 'approved' && r.status !== 'sending') || !r.segment_id || !r.venue_id || !r.body) return { queued: 0, suppressed: 0, remaining: 0 };
  // A venue that switched campaigns off since the approval sends nothing more.
  try {
    await assertModule(ctx, r.venue_id, campaignsModule);
  } catch (e) {
    if (e instanceof AppError) return { queued: 0, suppressed: 0, remaining: 0 };
    throw e;
  }
  const settings = await getCampaignsSettings(ctx);
  const seg = await loadSegment(ctx, r.segment_id);
  const frame = await compileFrame(ctx);
  const where = sql<boolean>`${audienceWhere(ctx, { rule: seg.definition, venueId: r.venue_id }, frame)} and ${reachableSql(r.channel)}`;
  const notYet = sql<boolean>`not exists (select 1 from messages m where m.org_id = c.org_id and m.campaign_id = ${r.id} and m.customer_id = c.id)`;

  if (r.status === 'approved') {
    const n = await sql<{ n: number }>`select count(*)::int as n from customers c left join fact_customer f on f.org_id = c.org_id and f.customer_id = c.id where ${where}`.execute(ctx.db);
    await ctx.db.updateTable('campaigns').set({ status: 'sending', audience_count: n.rows[0]!.n, updated_at: ctx.now() }).where('id', '=', r.id).execute();
  }

  const batch = await sql<{ id: string; first_name: string | null }>`
    select c.id, c.first_name from customers c
    left join fact_customer f on f.org_id = c.org_id and f.customer_id = c.id
    where ${where} and ${notYet}
    order by c.id
    limit ${settings.campaignWaveSize}`.execute(ctx.db);

  let queued = 0;
  let suppressed = 0;
  for (const g of batch.rows) {
    const first = g.first_name ?? 'there';
    let body = personalise(r.body, first);
    if (r.offer_id) {
      const offer = await offerLineFor(ctx, { offerId: r.offer_id, customerId: g.id, source: `campaign:${r.id}`, channel: r.channel });
      if (offer.line) body += `\n\n${offer.line}`;
    }
    const q = await queueMessage(ctx, {
      templateKey: CAMPAIGN_TEMPLATE_KEY,
      channel: r.channel,
      customerId: g.id,
      venueId: r.venue_id,
      campaignId: r.id,
      idempotencyKey: `campaign:${r.id}:${g.id}`,
      variables: { subject: r.subject ? personalise(r.subject, first) : r.name, body },
    });
    if (q.status === 'queued') queued++;
    else suppressed++;
  }

  const left = await sql<{ n: number }>`select count(*)::int as n from customers c left join fact_customer f on f.org_id = c.org_id and f.customer_id = c.id where ${where} and ${notYet}`.execute(ctx.db);
  const remaining = left.rows[0]!.n;
  const prior = (r.stats ?? {}) as { queued?: number; suppressed?: number; waves?: number };
  const stats = { queued: (prior.queued ?? 0) + queued, suppressed: (prior.suppressed ?? 0) + suppressed, waves: Math.max(prior.waves ?? 0, wave) };
  await track(ctx, campaignWaveQueued, { campaign_id: r.id, wave, queued, suppressed, remaining }, { venueId: r.venue_id });

  if (remaining > 0 && batch.rows.length > 0) {
    await ctx.db.updateTable('campaigns').set({ stats: json(stats), updated_at: ctx.now() }).where('id', '=', r.id).execute();
    await enqueue(ctx, campaignSendJob, { campaignId: r.id, wave: wave + 1 }, { key: `campaign:${r.id}:w${wave + 1}`, runAt: new Date(ctx.now().getTime() + settings.waveIntervalMinutes * 60_000) });
  } else {
    await ctx.db.updateTable('campaigns').set({ status: 'sent', sent_at: ctx.now(), stats: json(stats), updated_at: ctx.now() }).where('id', '=', r.id).execute();
    await track(ctx, campaignSent, { campaign_id: r.id, queued: stats.queued, suppressed: stats.suppressed, waves: stats.waves }, { venueId: r.venue_id });
  }
  return { queued, suppressed, remaining };
}

export const campaignSendJob = defineJob({
  kind: 'campaigns.campaign_send',
  schema: z.object({ campaignId: z.string().uuid(), wave: z.number().int().min(1) }),
  maxAttempts: 6,
  async handler(app, job) {
    if (!job.orgId) throw new Error('campaigns.campaign_send needs an org');
    await app.tenant(job.orgId, { kind: 'worker', job: 'campaigns.campaign_send' }, (ctx) => sendCampaignWave(ctx, job.payload.campaignId, job.payload.wave));
  },
});

// ── Results ───────────────────────────────────────────────────────────────────

export interface CampaignResults {
  campaignId: string;
  status: CampaignStatus;
  audienceCount: number | null;
  messages: { queued: number; suppressed: number; sent: number; delivered: number; opened: number; clicked: number; bounced: number; unsubscribed: number };
  codes: { issued: number; redeemed: number };
  /** Sales whose last touch is the campaign, or a code it issued: aligned with it, not proof it caused them. */
  attributed: { orders: number; guests: number; revenueCents: number };
}

/** Message counts from the event stream, codes from the offer events, and attributed sales from the ledger's attribution. */
export async function resultsFor(ctx: Ctx, key: { campaignId?: string; flowId?: string; source: string; touchCampaignId: string }): Promise<Omit<CampaignResults, 'campaignId' | 'status' | 'audienceCount'>> {
  const prop = key.campaignId ? 'campaign_id' : 'flow_id';
  const id = key.campaignId ?? key.flowId!;
  const m = await sql<{ name: string; n: number }>`
    select name, count(distinct properties->>'message_id')::int as n
    from events
    where org_id = ${ctx.orgId} and name like 'message.%' and properties->>${prop} = ${id}
    group by name`.execute(ctx.db);
  const count = (name: string) => m.rows.find((r) => r.name === `message.${name}`)?.n ?? 0;
  const codes = await sql<{ issued: number; redeemed: number }>`
    with a_issued as (
      select properties->>'code_id' as code_id from events
      where org_id = ${ctx.orgId} and name = 'offer.issued' and properties->>'source' = ${key.source}
    )
    select (select count(*) from a_issued)::int as issued,
           (select count(distinct e.properties->>'code_id') from events e
             where e.org_id = ${ctx.orgId} and e.name = 'offer.redeemed' and e.properties->>'code_id' in (select code_id from a_issued))::int as redeemed`.execute(ctx.db);
  const sales = await sql<{ orders: number; guests: number; revenue: number }>`
    select count(distinct t.id)::int as orders, count(distinct t.customer_id)::int as guests,
           coalesce(sum(t.total_cents - t.refunded_cents), 0)::bigint as revenue
    from transaction_attributions a
    join transactions t on t.id = a.transaction_id
    where a.org_id = ${ctx.orgId} and a.model = 'last_touch'
      and (a.campaign_id = ${key.touchCampaignId}
           or a.code in (select e.code from events e where e.org_id = ${ctx.orgId} and e.name = 'offer.issued' and e.properties->>'source' = ${key.source} and e.code is not null))
      and t.status in ('completed', 'partially_refunded')`.execute(ctx.db);
  const queued = await ctx.db
    .selectFrom('messages')
    .select((eb) => [eb.fn.countAll<number>().filterWhere('status', '!=', 'suppressed').as('queued'), eb.fn.countAll<number>().filterWhere('status', '=', 'suppressed').as('suppressed')])
    .where(key.campaignId ? 'campaign_id' : 'flow_id', '=', id)
    .executeTakeFirstOrThrow();
  return {
    messages: {
      queued: Number(queued.queued),
      suppressed: Number(queued.suppressed),
      sent: count('sent'),
      delivered: count('delivered'),
      opened: count('opened'),
      clicked: count('clicked'),
      bounced: count('bounced'),
      unsubscribed: count('unsubscribed'),
    },
    codes: { issued: codes.rows[0]!.issued, redeemed: codes.rows[0]!.redeemed },
    attributed: { orders: sales.rows[0]!.orders, guests: sales.rows[0]!.guests, revenueCents: Number(sales.rows[0]!.revenue) },
  };
}

/** How a campaign did. Anyone at the venue (read only and above); totals, never guests. */
export async function getCampaignResults(ctx: Ctx, raw: { campaignId: string }): Promise<CampaignResults> {
  const input = z.object({ campaignId: z.string().uuid() }).parse(raw);
  const r = await loadCampaign(ctx, input.campaignId, { minRole: 'read_only' });
  const res = await resultsFor(ctx, { campaignId: r.id, source: `campaign:${r.id}`, touchCampaignId: r.id });
  return { campaignId: r.id, status: r.status, audienceCount: r.audience_count, ...res };
}
