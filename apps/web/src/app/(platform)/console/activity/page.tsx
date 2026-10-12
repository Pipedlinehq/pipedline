import { listActivity, listPlugs } from '@ros/core';
import { events, hub, ledger } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { WHEN_OPTIONS, resolveView, whenRange, type ViewSpec } from '@/lib/console-views';
import { describeActor, describeAudit, describeToolCall, type Tone } from '@/lib/console-activity-words';
import { app } from '@/lib/runtime';
import { NotForYourRole, ReadError } from '@/components/console/states';
import { IndexViews } from '@/components/console/views';
import { Badge, Card, EmptyState, PageHeader } from '@/ui';
import { deleteView, renameView, saveView } from '../views-actions';

export const metadata = { title: 'Activity · Pipedline' };

/**
 * The activity log (docs/CONSOLE_IA.md section 9, wave 1; pattern 15): who did what and when, in
 * hospo words: "Sam 86'd the barramundi 19:40 · Assistant changed Friday's hours · Square posted
 * 212 dockets". Three records feed it: the audit log (every change a venue could dispute), the
 * assistant's calls (which tool, how it went; never arguments), and what connected services
 * posted into the sales record. Managers and owners; an owner sees the whole organisation, a
 * manager the venues they manage.
 */
const WHO_OPTIONS = [
  { value: 'staff', label: 'The team' },
  { value: 'assistant', label: 'Assistants' },
  { value: 'agents', label: 'Agents Pipedline runs' },
  { value: 'services', label: 'Connected services' },
  { value: 'pipedline', label: 'Pipedline itself' },
];

const SPEC: ViewSpec = {
  page: 'activity',
  path: '/console/activity',
  landing: 'all',
  defaults: [
    { key: 'all', label: 'Everything', filters: { when: '7d' } },
    { key: 'staff', label: 'The team', filters: { who: 'staff', when: '7d' } },
    { key: 'assistant', label: 'Assistants', filters: { who: 'assistant', when: '28d' } },
    { key: 'services', label: 'Connected services', filters: { who: 'services', when: '28d' } },
    { key: 'today', label: 'Today', filters: { when: 'today' } },
  ],
  fields: [
    { key: 'who', label: 'Who', kind: 'select', options: WHO_OPTIONS },
    { key: 'when', label: 'When', kind: 'select', options: WHEN_OPTIONS },
    { key: 'q', label: 'Words', kind: 'text', placeholder: 'barramundi, hours, refund' },
  ],
};

const ACTOR_KINDS: Record<string, string[]> = {
  staff: ['staff'],
  assistant: ['agent'],
  services: ['service_key'],
  pipedline: ['worker', 'platform', 'device'],
};

interface Line {
  key: string;
  at: Date;
  who: { label: string; badge?: { text: string; tone: Tone } };
  text: string;
  venue?: string;
  tone?: 'bad';
}

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Activity">The record of who did what is for managers and owners.</NotForYourRole>;
  const saved = await read((ctx) => events.listConsoleViews(ctx, { venueId: c.venue.id, page: 'activity' }));
  const resolved = resolveView(SPEC, sp, saved.ok ? saved.data : []);
  const f = resolved.filters;
  const tz = c.venue.timezone;
  const now = app().clock();
  const range = whenRange(f.when, now, tz);
  const who = f.who;
  const wantAudit = !who || who in ACTOR_KINDS || who === 'agents';
  const wantCalls = !who || who === 'assistant' || who === 'agents';
  const wantIngest = !who || who === 'services';

  const [audits, calls, keys, pos] = await Promise.all([
    wantAudit ? read((ctx) => listActivity(ctx, { venueId: c.venue.id, actorKinds: who === 'agents' ? ['agent'] : who ? ACTOR_KINDS[who] : undefined, from: range?.from, to: range?.to, limit: 300 })) : null,
    wantCalls ? read((ctx) => hub.listAgentCalls(ctx, { limit: 200 })) : null,
    read((ctx) => hub.listAgentKeys(ctx)),
    wantIngest ? read((ctx) => ledger.listPosConnections(ctx, { venueId: c.venue.id })) : null,
  ]);
  const keyNames = new Map((keys.ok ? keys.data : []).map((k) => [k.id, k.name]));
  const hostedAgentNames = new Map(hub.listHostedAgents().map((a) => [a.key, a.name]));
  const plugNames = new Map(listPlugs().map((p) => [p.key, p.name]));
  const cx = { keyNames, hostedAgentNames, plugNames };
  const venueName = new Map(c.venues.map((v) => [v.id, v.name]));
  const inRange = (at: Date) => !range || (at >= range.from && at < range.to);

  const lines: Line[] = [];
  for (const a of audits?.ok ? audits.data : []) {
    const hosted = a.actorKind === 'agent' && a.actorId?.startsWith('hosted:');
    if (who === 'assistant' && hosted) continue;
    if (who === 'agents' && !hosted) continue;
    lines.push({ key: `a:${a.id}`, at: a.occurredAt, who: describeActor(a, cx), text: describeAudit(a), venue: a.venueId ? venueName.get(a.venueId) : undefined, tone: /refund|cancel|reject|erase|fail|revoke|disable|remove|delete/.test(a.action) ? 'bad' : undefined });
  }
  for (const k of calls?.ok ? calls.data : []) {
    if (!inRange(k.occurredAt)) continue;
    const hosted = k.plugKey === 'os' && k.keyId === null;
    if (who === 'assistant' && hosted) continue;
    if (who === 'agents' && !hosted) continue;
    const label = hosted ? 'An agent Pipedline runs' : k.keyName ? `Assistant (${k.keyName})` : 'Assistant';
    lines.push({ key: `c:${k.id}`, at: k.occurredAt, who: { label, badge: { text: hosted ? 'Agent' : 'Assistant', tone: 'accent' } }, text: describeToolCall(k, cx), tone: /failed|refused|unsure/.test(k.outcome) ? 'bad' : undefined });
  }
  for (const p of pos?.ok ? pos.data : []) {
    if (!p.lastRunAt || !inRange(p.lastRunAt)) continue;
    const name = plugNames.get(p.plugKey) ?? p.plugKey;
    lines.push({
      key: `p:${p.id}`,
      at: p.lastRunAt,
      who: { label: name, badge: { text: 'Connected service', tone: 'neutral' } },
      text: p.lastError ? `could not post sales: ${p.lastError}` : `posted sales into the record${p.syncedThrough ? `, up to ${when(p.syncedThrough, tz)}` : ''}`,
      venue: venueName.get(p.venueId),
      tone: p.lastError ? 'bad' : undefined,
    });
  }
  const needle = f.q?.toLowerCase();
  const shown = lines
    .filter((l) => !needle || `${l.who.label} ${l.text}`.toLowerCase().includes(needle))
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 300);
  const problems = [audits, calls, pos].filter((r): r is { ok: false; error: string; code: string } => !!r && !r.ok).map((r) => r.error);

  // Days as headings, so a long log reads as a diary.
  const byDay = new Map<string, Line[]>();
  for (const l of shown) {
    const day = new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(l.at);
    byDay.set(day, [...(byDay.get(day) ?? []), l]);
  }

  return (
    <>
      <PageHeader
        title="Activity"
        description={`Who did what at ${c.venue.name}, and when: the team, your assistant, the agents Pipedline runs for you, and the services you have connected. ${c.isOwner ? 'As an owner you see the whole organisation.' : 'You see the venues you manage.'}`}
      />
      <IndexViews page="activity" path="/console/activity" resolved={resolved} fields={SPEC.fields} canSave saveAction={saveView} renameAction={renameView} deleteAction={deleteView} aside={`${shown.length} ${shown.length === 1 ? 'entry' : 'entries'}${shown.length >= 300 ? ' (the latest 300)' : ''}`} />
      {problems.length ? <ReadError message={`Part of the log could not be read: ${problems.join(' ')}`} /> : null}
      {shown.length === 0 ? (
        <EmptyState title="Nothing in this view">Try a longer period, or another view.</EmptyState>
      ) : (
        <div className="space-y-6">
          {[...byDay.entries()].map(([day, items]) => (
            <Card key={day} title={day} padded={false}>
              <ol className="divide-y divide-line" data-testid="activity-list">
                {items.map((l) => (
                  <li key={l.key} className="flex items-start gap-3 px-5 py-3 text-sm" data-testid="activity-line" data-who={l.who.badge?.text ?? 'Team'}>
                    <time dateTime={l.at.toISOString()} className="w-16 shrink-0 tabular-nums text-ink-2">
                      {new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(l.at)}
                    </time>
                    <p className={`min-w-0 flex-1 ${l.tone === 'bad' ? 'text-bad' : 'text-ink'}`}>
                      <span className="font-medium">{l.who.label}</span>{' '}
                      {l.who.badge ? (
                        <>
                          <Badge tone={l.who.badge.tone}>{l.who.badge.text}</Badge>{' '}
                        </>
                      ) : null}
                      {l.text}
                      {l.venue && c.venues.length > 1 ? <span className="text-ink-3"> · {l.venue}</span> : null}
                    </p>
                  </li>
                ))}
              </ol>
            </Card>
          ))}
        </div>
      )}
      <p className="mt-6 text-xs text-ink-3">The log is kept, never edited. Arguments an assistant sent and answers it got are never stored, only which tool and how it went.</p>
    </>
  );
}

function when(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: tz, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(at);
}

