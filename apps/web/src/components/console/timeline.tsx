import type { ReactNode } from 'react';
import { listEntityAudit } from '@ros/core';
import { events, hub } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { describeActor, describeAudit, describeEvent, type Tone } from '@/lib/console-activity-words';
import { Badge, Card } from '@/ui';
import { InlineAction } from './confirm';
import { NoteForm } from './note-form';
import { addNote, removeNote } from '@/app/(platform)/console/notes-actions';

/**
 * A record's history (docs/CONSOLE_IA.md section 9, wave 1; pattern 3): what the system recorded
 * (the audit log and the activity stream), the page's own steps, and the notes staff left, all
 * in one list, newest first. Who did each thing is named; an assistant is badged "Assistant", a
 * hosted agent with its name, a connected service with its name. Guest-written and staff-written
 * text is rendered as text.
 *
 * Wave-2 builders: mount <Timeline entityType entityId venueId steps? /> on a detail page. Pass
 * the record's own steps (status changes with their times) as `steps`; the component adds the
 * audit entries, the events and the notes.
 */
export interface TimelineStep {
  /** For tests and styling: 'step', 'refund', 'delivery', ... */
  kind: string;
  label: string;
  detail?: string;
  /** Null: not happened yet; listed under "still to come". */
  at: Date | null;
  tone?: 'bad';
}

interface Entry {
  key: string;
  kind: string;
  at: Date;
  who?: { label: string; badge?: { text: string; tone: Tone } };
  text: ReactNode;
  detail?: ReactNode;
  tone?: 'bad';
  noteId?: string;
  canRemove?: boolean;
}

export async function Timeline({ entityType, entityId, venueId, steps = [], title = 'Timeline', testId = 'timeline', description }: { entityType: 'order' | 'booking' | 'customer'; entityId: string; venueId: string; steps?: TimelineStep[]; title?: string; testId?: string; description?: string }) {
  const c = await getConsole();
  const role = c.session.principal.venueRoles[venueId] ?? 'read_only';
  const manager = atLeast(role, 'manager');
  const canNote = role !== 'read_only';
  const venue = c.venues.find((v) => v.id === venueId) ?? c.venue;
  const tz = venue.timezone;
  const [notes, audits, stream, people, keys] = await Promise.all([
    read((ctx) => events.listStaffNotes(ctx, { venueId, entityType, entityId })),
    read((ctx) => listEntityAudit(ctx, { entityType, entityId, venueId })),
    read((ctx) => events.listEntityEvents(ctx, { venueId, entityType, entityId })),
    canNote ? read((ctx) => events.listMentionableStaff(ctx, { venueId })) : null,
    manager ? read((ctx) => hub.listAgentKeys(ctx)) : null,
  ]);
  const keyNames = new Map((keys?.ok ? keys.data : []).map((k) => [k.id, k.name]));
  const hostedAgentNames = new Map(hub.listHostedAgents().map((a) => [a.key, a.name]));
  const cx = { keyNames, hostedAgentNames };

  const entries: Entry[] = [];
  for (const s of steps) if (s.at) entries.push({ key: `step:${s.kind}:${s.label}:${s.at.getTime()}`, kind: s.kind, at: s.at, text: s.label, detail: s.detail, tone: s.tone });
  for (const a of audits.ok ? audits.data : []) {
    const who = describeActor(a, cx);
    entries.push({ key: `audit:${a.id}`, kind: 'audit', at: a.occurredAt, who, text: describeAudit(a), tone: /refund|cancel|reject|erase|fail/.test(a.action) ? 'bad' : undefined });
  }
  for (const e of stream.ok ? stream.data : []) {
    const words = describeEvent(e.name, e.properties);
    if (!words) continue;
    entries.push({ key: `event:${e.id}`, kind: 'event', at: e.occurredAt, who: e.source === 'agent' ? { label: 'Assistant', badge: { text: 'Assistant', tone: 'accent' } } : undefined, text: words, tone: /fail|cancel|reject|no_show|bounce/.test(e.name) ? 'bad' : undefined });
  }
  for (const n of notes.ok ? notes.data : []) {
    const isAgent = n.authorKind === 'agent';
    entries.push({
      key: `note:${n.id}`,
      kind: 'note',
      at: n.createdAt,
      who: { label: isAgent ? `Assistant for ${n.authorName ?? 'a team member'}` : (n.authorName ?? 'A team member'), badge: isAgent ? { text: 'Assistant', tone: 'accent' } : { text: 'Note', tone: 'neutral' } },
      text: <span className="whitespace-pre-wrap break-words">{n.body}</span>,
      noteId: n.id,
      canRemove: canNote && (manager || n.authorId === c.session.principal.staffId),
    });
  }
  // An event that says what a page step already says (the step "Accepted" and the event
  // order.accepted a moment later) reads once: the step, which the page words best. Steps,
  // audit entries and notes are never dropped.
  const firstWord = (t: ReactNode) => (typeof t === 'string' ? t.toLowerCase().split(/[ ,:]/)[0] ?? '' : '');
  const stepMoments = new Map<string, number[]>();
  for (const e of entries) {
    if (e.kind === 'audit' || e.kind === 'note' || e.kind === 'event') continue;
    const w = firstWord(e.text);
    stepMoments.set(w, [...(stepMoments.get(w) ?? []), e.at.getTime()]);
  }
  const saidByAStep = (e: Entry) => (stepMoments.get(firstWord(e.text)) ?? []).some((t) => Math.abs(t - e.at.getTime()) <= 2000);
  const list = entries.filter((e) => e.kind !== 'event' || !saidByAStep(e)).sort((a, b) => b.at.getTime() - a.at.getTime());
  const pending = steps.filter((s) => !s.at);
  const problems = [notes, audits, stream].filter((r) => !r.ok).map((r) => (r as { error: string }).error);

  return (
    <Card title={title} description={description} padded={false}>
      {canNote && people?.ok ? (
        <div className="border-b border-line px-5 py-4">
          <NoteForm action={addNote} venueId={venueId} entityType={entityType} entityId={entityId} people={people.data} />
        </div>
      ) : null}
      {list.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-3">Nothing on the record yet.</p>
      ) : (
        <ol className="divide-y divide-line" data-testid={testId}>
          {list.map((e) => (
            <li key={e.key} data-kind={e.kind} className="flex items-start gap-3 px-5 py-3">
              <div className="min-w-0 flex-1 text-sm">
                <p className={e.tone === 'bad' ? 'text-bad' : 'text-ink'}>
                  {e.who ? (
                    <>
                      <span className="font-medium">{e.who.label}</span>{' '}
                      {e.who.badge ? (
                        <>
                          <Badge tone={e.who.badge.tone}>{e.who.badge.text}</Badge>{' '}
                        </>
                      ) : null}
                    </>
                  ) : null}
                  {e.text}
                </p>
                {e.detail ? <p className="mt-0.5 text-xs text-ink-2">{e.detail}</p> : null}
                {e.noteId && e.canRemove ? (
                  <div className="mt-1">
                    <InlineAction action={removeNote} hidden={{ noteId: e.noteId, entityType, entityId }} label="Remove note" pendingLabel="…" variant="secondary" />
                  </div>
                ) : null}
              </div>
              <time dateTime={e.at.toISOString()} className="shrink-0 text-xs tabular-nums text-ink-2">
                {when(e.at, tz)}
              </time>
            </li>
          ))}
        </ol>
      )}
      {pending.length ? (
        <p className="border-t border-line px-5 py-3 text-xs text-ink-3" data-testid={`${testId}-pending`}>
          Still to come: {pending.map((s) => s.label).join(' · ')}
        </p>
      ) : null}
      {problems.length ? <p className="border-t border-line px-5 py-3 text-xs text-ink-3">Part of the history could not be read: {problems.join(' ')}</p> : null}
    </Card>
  );
}

/** "30 Sep, 7:19 pm" in the venue's zone. */
function when(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: tz, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(at);
}
