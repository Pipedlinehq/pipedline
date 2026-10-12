import type { AuditEntryView } from '@ros/core';

/**
 * Hospo words for what the record says happened (docs/CONSOLE_IA.md section 9, wave 1: the
 * Timeline and the Activity log). An audit action is `entity.verb`; an event is `noun.verb`; a
 * tool call is a tool name. Each becomes a sentence a venue owner reads without a glossary:
 * "86'd the barramundi", "changed Friday's hours", "read the sales summary". Anything without
 * its own words falls back to a plain reading of the name, so nothing is hidden.
 */
export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

export interface Who {
  /** The name shown: "Morgan Manager", "Assistant", "Ops watch", "Square", "Pipedline". */
  label: string;
  /** A badge beside the name for anything that is not a person at the venue. */
  badge?: { text: string; tone: Tone };
}

export interface WhoContext {
  /** Assistant key id → the key's name, where the reader may know it. */
  keyNames?: Map<string, string>;
  /** Hosted agent key → its name ("Ops watch"). */
  hostedAgentNames?: Map<string, string>;
  /** Connected service plug key → its name ("Square"). */
  plugNames?: Map<string, string>;
}

const HOSTED = /^hosted:(.+)$/;

/** Who an audit entry's actor is, in words and with a badge when it was not a person. */
export function describeActor(e: Pick<AuditEntryView, 'actorKind' | 'actorId' | 'actorName'>, cx: WhoContext = {}): Who {
  switch (e.actorKind) {
    case 'staff':
      return { label: e.actorName ?? 'A team member' };
    case 'agent': {
      const hosted = e.actorId ? HOSTED.exec(e.actorId) : null;
      if (hosted) {
        const name = cx.hostedAgentNames?.get(hosted[1]!) ?? titleCase(hosted[1]!);
        return { label: name, badge: { text: name, tone: 'accent' } };
      }
      const key = e.actorId ? cx.keyNames?.get(e.actorId) : undefined;
      return { label: key ? `Assistant (${key})` : 'Assistant', badge: { text: 'Assistant', tone: 'accent' } };
    }
    case 'service_key':
      return { label: 'A connected service', badge: { text: 'Connected service', tone: 'neutral' } };
    case 'worker':
      return { label: 'Pipedline', badge: { text: 'Automatic', tone: 'neutral' } };
    case 'platform':
      return { label: 'Pipedline support', badge: { text: 'Support', tone: 'warn' } };
    case 'device':
      return { label: 'Kitchen screen', badge: { text: 'Kitchen screen', tone: 'neutral' } };
    case 'guest':
      return { label: 'The guest', badge: { text: 'Guest', tone: 'neutral' } };
    case 'anon':
      return { label: 'A visitor', badge: { text: 'Visitor', tone: 'neutral' } };
    default:
      return { label: e.actorName ?? e.actorKind };
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const titleCase = (s: string) => s.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const dollars = (cents: unknown, currency = 'AUD') => (num(cents) === null ? null : new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(num(cents)! / 100));

/** "the barramundi" from an after/before row with a name, or "the item". */
const named = (e: AuditEntryView, noun: string): string => {
  const a = rec(e.after);
  const b = rec(e.before);
  const name = str(a.name) ?? str(b.name) ?? str(a.title) ?? str(b.title) ?? str(a.reference) ?? str(b.reference);
  return name ? `${noun} “${name}”` : `the ${noun}`;
};

const BOOKING_VERBS: Record<string, string> = {
  requested: 'took a booking request',
  confirmed: 'confirmed the booking',
  declined: 'declined the booking',
  cancelled: 'cancelled the booking',
  seated: 'seated the table',
  no_show: 'marked the booking a no-show',
  completed: 'finished the booking',
  added: 'took a phone booking',
};

const CONSENT_WORDS: Record<string, string> = { marketing_email: 'marketing email', marketing_sms: 'marketing texts', card_recognition: 'card recognition', ad_platform_sharing: 'sharing with ad platforms' };

type Words = (e: AuditEntryView) => string;

const AUDIT_WORDS: Record<string, Words> = {
  'order.refund_requested': (e) => `asked for a refund of ${dollars(rec(e.after).amountCents ?? rec(e.after).amount_cents) ?? 'part of the order'}`,
  'order.refunded': (e) => `refunded ${dollars(rec(e.after).amountCents ?? rec(e.after).amount_cents ?? rec(e.after).refundedCents) ?? 'the order'}`,
  'order.attention_cleared': () => 'marked the order as dealt with',
  'order.switched_to_pickup': () => 'switched the order to pickup',
  'order.discount_absorbed': () => 'absorbed a discount the guest kept',
  'menu.item_86': (e) => `86'd ${named(e, 'item')}`,
  'menu.item_restored': (e) => `put ${named(e, 'item')} back on the menu`,
  'menu.modifier_86': (e) => `86'd ${named(e, 'choice')}`,
  'menu.modifier_restored': (e) => `put ${named(e, 'choice')} back`,
  'module.set': (e) => {
    const a = rec(e.after);
    const b = rec(e.before);
    const key = e.entityId?.split(':')[1] ?? 'a plugin';
    if (typeof a.enabled === 'boolean' && a.enabled !== b.enabled) return `switched ${titleCase(key)} ${a.enabled ? 'on' : 'off'}`;
    return `changed the ${titleCase(key)} settings`;
  },
  'hours.set': () => 'changed the weekly hours',
  'hours.exception_set': (e) => {
    const a = rec(e.after);
    const date = str(a.date) ?? e.entityId ?? 'a day';
    return a.closed === true ? `closed the venue on ${dayWords(date)}` : `set special hours for ${dayWords(date)}`;
  },
  'hours.exception_removed': (e) => `took the special hours off ${dayWords(str(rec(e.before).date) ?? e.entityId ?? 'a day')}`,
  'venue.updated': () => 'changed the venue details',
  'venue.created': () => 'added a venue',
  'org.settings': (e) => `changed the ${titleCase(str(rec(e.after).namespace) ?? 'organisation')} settings`,
  'org.updated': () => 'changed the organisation details',
  'org.went_live': () => 'took the venue live',
  'staff.invited': (e) => `invited ${str(rec(e.after).firstName) ?? 'someone'} to the team`,
  'staff.roles_set': (e) => `changed ${str(rec(e.after).firstName) ?? "a team member's"}${str(rec(e.after).firstName) ? "'s" : ''} role`,
  'staff.disabled': (e) => `removed ${str(rec(e.before).firstName) ?? 'a team member'} from the team`,
  'agent_key.created': (e) => `made an assistant key${str(rec(e.after).name) ? ` “${str(rec(e.after).name)}”` : ''}`,
  'agent_key.revoked': (e) => `revoked the assistant key${str(rec(e.before).name) ? ` “${str(rec(e.before).name)}”` : ''}`,
  'agent_key.can_write_set': (e) => (rec(e.after).canWrite === true ? 'allowed an assistant to propose changes' : 'stopped an assistant from proposing changes'),
  'agent_oauth.agreed': () => 'signed an assistant in',
  'agent_oauth.declined': () => 'turned an assistant sign-in down',
  'agent.action_approved': () => 'approved something a hosted agent proposed',
  'offer.created': (e) => `created ${named(e, 'offer')}`,
  'offer.updated': (e) => `changed ${named(e, 'offer')}`,
  'offer.codes_issued': (e) => `issued ${num(rec(e.after).count) ?? 'some'} offer codes`,
  'offer.code_issued': () => 'issued an offer code',
  'offer.code_voided': () => 'cancelled an offer code',
  'offer.code_redeemed_by_staff': () => 'marked an offer code as used at the till',
  'campaign.drafted': (e) => `drafted ${named(e, 'campaign')}`,
  'campaign.updated': (e) => `changed ${named(e, 'campaign')}`,
  'campaign.submitted': (e) => `sent ${named(e, 'campaign')} for approval`,
  'campaign.cancelled': (e) => `cancelled ${named(e, 'campaign')}`,
  'campaign.copy_drafted': () => 'drafted campaign copy',
  'campaign.approved': () => 'approved a campaign',
  'campaign.rejected': () => 'said no to a campaign',
  'approval.approved': () => 'said yes',
  'approval.rejected': () => 'said no',
  'customer.updated': () => "updated the guest's details",
  'customer.merged': () => 'merged two guest records',
  'customer.exported': () => "exported the guest's records",
  'customer.erased': () => 'erased the guest at their request',
  'consent.revoked': (e) => `withdrew the guest's ${CONSENT_WORDS[str(rec(e.after).purpose) ?? ''] ?? 'consent'} at their request`,
  'page.created': (e) => `created ${named(e, 'page')}`,
  'page.published': (e) => `published ${named(e, 'page')}`,
  'page.unpublished': (e) => `took ${named(e, 'page')} off the site`,
  'page.draft_saved': (e) => `saved a draft of ${named(e, 'page')}`,
  'page.draft_discarded': (e) => `discarded the draft of ${named(e, 'page')}`,
  'page.deleted': (e) => `deleted ${named(e, 'page')}`,
  'page.copy_updated': (e) => `changed the words on ${named(e, 'page')}`,
  'brand.updated': () => 'changed the brand kit',
  'brand.override_cleared': () => "cleared a venue's brand override",
  'media.uploaded': () => 'uploaded an image',
  'media.removed': () => 'removed an image',
  'media.alt_set': () => "wrote an image's description",
  'domain.added': (e) => `added the domain ${str(rec(e.after).host) ?? ''}`.trim(),
  'domain.verified': (e) => `verified the domain ${str(rec(e.after).host) ?? ''}`.trim(),
  'domain.removed': (e) => `removed the domain ${str(rec(e.before).host) ?? ''}`.trim(),
  'redirects.imported': () => 'imported redirects',
  'redirects.removed': () => 'removed a redirect',
  'device.pairing_started': () => 'started pairing a kitchen screen',
  'device.revoked': () => 'removed a kitchen screen',
  'qr.code_created': () => 'made a QR code',
  'qr.code_updated': () => 'changed a QR code',
  'qr.table_codes_created': (e) => `made QR codes for ${num(rec(e.after).count) ?? 'the'} tables`,
  'qr.table_session_closed': (e) => `closed table ${str(rec(e.after).tableLabel) ?? str(rec(e.before).tableLabel) ?? ''}`.trim(),
  'pos.backfill_requested': () => 'asked the till for past sales',
  'connection.signin_started': () => 'started connecting a service',
  'connection.revoked': () => 'disconnected a service',
  'plug.tool_call': () => "used a connected service's tool",
  'delivery.cancelled': () => 'cancelled the delivery',
  'delivery.failed': () => 'recorded a failed delivery',
  'delivery.no_courier': () => 'found no courier for the delivery',
  'delivery.zone_deactivated': () => 'switched a delivery area off',
  'loyalty.enrolled_at_counter': () => 'signed a guest up to loyalty at the counter',
  'loyalty.points_adjusted': () => "adjusted a member's points",
  'loyalty.redemption_issued': () => 'issued a loyalty reward',
  'loyalty.redemption_voided': () => 'cancelled a loyalty reward',
  'loyalty.redemption_forced': () => 'marked a loyalty reward as used',
  'loyalty.member_status': () => "changed a member's status",
  'loyalty.tier_deleted': () => 'removed a loyalty tier',
  'loyalty.backfill_run': () => 'worked out loyalty points from past sales',
  'review.reply_drafted': () => 'drafted a reply to a review',
  'review.reply_approved': () => 'approved a review reply',
  'review.reply_posted': () => 'posted a reply to a review',
  'segment.created': (e) => `created ${named(e, 'guest list')}`,
  'segment.updated': (e) => `changed ${named(e, 'guest list')}`,
  'segment.deleted': () => 'deleted a guest list',
  'flow.updated': () => 'changed a lifecycle flow',
  'flow.mode_set': (e) => `set a lifecycle flow to ${str(rec(e.after).mode) ?? 'a new mode'}`,
  'flow.template_pinned': () => "pinned a flow's message",
  'specials.posted': (e) => `posted ${named(e, 'special')}`,
  'specials.ended': () => 'ended a special',
  'sending_identity.added': () => 'added a sending address',
  'sending_identity.status': () => "changed a sending address's status",
  'suppression.added': () => 'stopped messages to an address',
  'menu_import.requested': () => 'started a menu import',
  'menu_import.item_confirmed': () => 'confirmed an imported item',
  'menu_import.item_edited': () => 'edited an imported item',
  'menu_import.item_discarded': () => 'discarded an imported item',
  'menu_import.discarded': () => 'discarded a menu import',
  'analytics.exported': () => 'exported a report',
  'analytics.view_pinned': () => 'pinned a report view',
  'analytics.view_deleted': () => 'deleted a report view',
  'console.view_saved': (e) => `saved the view “${str(rec(e.after).name) ?? ''}”`,
  'console.view_updated': (e) => `updated the view “${str(rec(e.after).name) ?? ''}”`,
  'console.view_renamed': (e) => `renamed the view “${str(rec(e.before).name) ?? ''}” to “${str(rec(e.after).name) ?? ''}”`,
  'console.view_deleted': (e) => `deleted the view “${str(rec(e.before).name) ?? ''}”`,
  'note.removed': () => 'removed a note',
  'support.access_opened': () => 'opened support access to the organisation',
  'support.access_closed': () => 'closed support access',
  'org.exported': () => "exported the organisation's records",
  'org.closed': () => 'closed the organisation',
  'org.quota_set': () => "set the organisation's quota",
  'org.self_serve_started': () => 'started the organisation',
  'onboarding.confirmed': () => 'confirmed a setup step',
};

/** "Friday 16 Oct" from a venue-local date, or the text as it came. */
function dayWords(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short' }).format(new Date(`${date}T00:00:00Z`));
}

const ENTITY_NOUNS: Record<string, string> = { console_view: 'view', menu_item: 'item', menu_section: 'section', modifier_group: 'group of choices', agent_key: 'assistant key', hour_exception: 'special hours' };

/** What an audit entry says happened, as a verb phrase after the actor's name. */
export function describeAudit(e: AuditEntryView): string {
  const own = AUDIT_WORDS[e.action];
  if (own) return own(e);
  const menu = /^menu\.(\w+)_(created|updated|deleted)$/.exec(e.action);
  if (menu) {
    const noun = ENTITY_NOUNS[menu[1]!] ?? menu[1]!.replace(/_/g, ' ');
    const verb = menu[2] === 'created' ? 'added' : menu[2] === 'updated' ? 'changed' : 'removed';
    return `${verb} ${named(e, noun)}`;
  }
  const booking = /^bookings\.(\w+)$/.exec(e.action);
  if (booking && BOOKING_VERBS[booking[1]!]) return BOOKING_VERBS[booking[1]!]!;
  const [entity = '', verb = ''] = e.action.split('.');
  const noun = ENTITY_NOUNS[entity] ?? entity.replace(/_/g, ' ');
  return `${verb.replace(/_/g, ' ')} the ${noun}`.trim();
}

/** Events from the activity stream worth a line on a record's timeline; others are left out. */
const EVENT_WORDS: Record<string, (p: Record<string, unknown>) => string> = {
  'order.placed': (p) => `Order placed${num(p.total_cents) !== null ? ` for ${dollars(p.total_cents)}` : ''}`,
  'order.paid': () => 'Placed and paid',
  'payment.failed': (p) => `A card payment failed${str(p.reason) ? `: ${str(p.reason)}` : ''}`,
  'order.accepted': (p) => (p.auto === true ? 'Accepted automatically' : 'Accepted'),
  'order.preparing': () => 'The kitchen started on it',
  'order.ready': (p) => `Marked ready${num(p.minutes_late) ? `, ${num(p.minutes_late)} min late` : ''}`,
  'order.completed': () => 'Handed over',
  'order.recalled': () => 'Put back to ready (the bump was a mis-tap)',
  'order.rejected': (p) => `Turned down${str(p.reason) ? `: ${str(p.reason)}` : ''}`,
  'order.cancelled': (p) => `Cancelled${str(p.reason) ? `: ${str(p.reason)}` : ''}`,
  'order.refunded': (p) => `Refunded ${dollars(p.refunded_cents) ?? ''}${p.full === true ? ' in full' : ''}`.trim(),
  'ticket.acknowledged': (p) => `Seen on the kitchen screen${num(p.seconds_to_acknowledge) !== null ? ` after ${num(p.seconds_to_acknowledge)} s` : ''}`,
  'order.pushed_to_pos': (p) => `Sent to the till${str(p.provider) ? ` (${titleCase(str(p.provider)!)})` : ''}`,
  'order.flagged': (p) => `Flagged for a person to look at${str(p.reason) ? `: ${str(p.reason)}` : ''}`,
  'order.switched_to_pickup': () => 'Switched to pickup',
  'booking.requested': (p) => `Booking ${p.status === 'confirmed' ? 'made' : 'requested'} for ${num(p.party_size) ?? ''} ${num(p.party_size) === 1 ? 'guest' : 'guests'}`,
  'booking.confirmed': (p) => (p.auto === true ? 'Confirmed automatically' : 'Confirmed'),
  'booking.declined': () => 'Declined',
  'booking.cancelled': (p) => `Cancelled by the ${str(p.by) ?? 'venue'}`,
  'booking.seated': (p) => `Seated${num(p.minutes_late) ? `, ${num(p.minutes_late)} min after the booked time` : ''}`,
  'booking.no_show': () => 'Marked a no-show',
  'booking.completed': () => 'Finished',
  'booking.reminded': () => 'Reminder sent to the guest',
  'customer.created': (p) => `First seen${str(p.via) ? ` via ${str(p.via)!.replace(/_/g, ' ')}` : ''}`,
  'customer.merged': () => 'Two records were merged into this one',
  'consent.changed': (p) => `${p.action === 'granted' ? 'Said yes to' : 'Withdrew'} ${CONSENT_WORDS[str(p.purpose) ?? ''] ?? 'a consent'}`,
  'loyalty.enrolled': () => 'Joined loyalty',
  'loyalty.points_earned': (p) => `Earned ${num(p.points) ?? ''} points`.replace(/\s+/g, ' '),
  'loyalty.reward_redeemed': () => 'Used a reward',
  'message.sent': (p) => `${titleCase(str(p.channel) ?? 'Message')} sent${str(p.kind) ? `: ${str(p.kind)!.replace(/[._]/g, ' ')}` : ''}`,
  'message.delivered': () => 'Message delivered',
  'message.bounced': () => 'Message bounced',
  'message.opened': () => 'Message opened',
  'message.clicked': () => 'A link in a message was clicked',
  'review.posted': () => 'Left a review',
  'offer.code_issued': () => 'Was given an offer code',
  'offer.code_redeemed': () => 'Used an offer code',
};

export function describeEvent(name: string, properties: Record<string, unknown>): string | null {
  const fn = EVENT_WORDS[name];
  return fn ? fn(properties) : null;
}

/** What an assistant did when it called a tool, as a verb phrase. Write tools say what was proposed or done. */
const TOOL_WORDS: Record<string, string> = {
  venue_status: 'checked whether the venue is open',
  venue_info: 'read the venue details',
  venue_describe: 'read the venue details',
  venue_update: 'changed the venue details',
  sales_summary: 'read the sales summary',
  customers_summary: 'read the guest numbers',
  campaigns_summary: 'read the campaign numbers',
  campaign_outcomes: 'read campaign outcomes',
  deliveries_summary: 'read the delivery numbers',
  loyalty_summary: 'read the loyalty numbers',
  menu_performance: 'read how the menu is selling',
  metrics_query: 'ran a figures query',
  metrics_catalogue: 'read the list of figures',
  saved_view_run: 'ran a saved report view',
  funnel_report: 'read the ordering funnel',
  insights_digest: 'read the weekly digest',
  event_dictionary: 'read the data dictionary',
  menu_list: 'read the menu',
  menu_read: 'read the menu',
  menu_set_availability: "86'd or restored a menu item",
  orders_list: 'read the orders',
  order_decide: 'accepted or rejected an order',
  bookings_today: "read today's bookings",
  bookings_list: 'read the bookings',
  booking_availability: 'checked booking availability',
  booking_confirm: 'confirmed a booking',
  booking_decline: 'declined a booking',
  booking_cancel: 'cancelled a booking',
  booking_add: 'took a booking',
  guest_lookup: 'looked a guest up',
  reviews_list: 'read the reviews',
  review_reply_draft: 'drafted a review reply',
  message_draft: 'drafted a message',
  hours_set_exception: "set a day's hours",
  specials_list: 'read the specials',
  special_post: 'posted a special',
  special_end: 'ended a special',
  page_copy: "read a page's words",
  page_update_copy: "changed a page's words",
  ops_status: 'checked how service is going',
  setup_status: 'checked the setup progress',
  plugins_list: 'read the plugin list',
  plugin_enable: 'switched a plugin on',
  plugin_configure: "changed a plugin's settings",
  plugin_disable: 'switched a plugin off',
  connections_list: 'read the connected services',
  connection_start: 'started connecting a service',
  menu_import_start: 'started a menu import',
  menu_import_review: 'reviewed a menu import',
  menu_import_confirm: 'confirmed a menu import',
  go_live_check: 'checked what is missing before going live',
  go_live_confirm: 'confirmed a go-live step',
  go_live_test_email: 'sent a test email',
  go_live: 'took the venue live',
  team_invite: 'invited someone to the team',
};

const OUTCOME_WORDS: Record<string, string> = {
  answered: '',
  confirmed: '',
  asked: ' (asked first; waiting for a yes)',
  declined: ' (the person said no)',
  refused: ' (refused: not allowed)',
  invalid: ' (the request did not make sense)',
  rate_limited: ' (slowed down: too many calls)',
  failed: ' (it failed)',
  unsure: ' (outcome unknown)',
};

export function describeToolCall(call: { tool: string; effect: string; outcome: string; plugKey: string }, cx: WhoContext = {}): string {
  const plug = call.plugKey && call.plugKey !== 'os' ? ` through ${cx.plugNames?.get(call.plugKey) ?? titleCase(call.plugKey)}` : '';
  const base = TOOL_WORDS[call.tool] ?? `${call.effect === 'write' ? 'used' : 'read with'} ${call.tool.replace(/__/g, ': ').replace(/_/g, ' ')}`;
  const outcome = OUTCOME_WORDS[call.outcome] ?? ` (${call.outcome.replace(/_/g, ' ')})`;
  return `${base}${plug}${outcome}`;
}
