import { type Ctx, type RemoteMcpTool } from '@ros/core';
import { hub, onboarding } from '@ros/modules';
import { app } from '@/lib/runtime';
import { platformActor } from '@/lib/ops-platform';
import { ActionForm, Badge, Card, EmptyState, PageHeader, SubmitButton, dateTime } from '@/ui';
import { approvePlugAction } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Plug review · Platform' };

type State = 'pinned' | 'not_reviewed' | 'changed' | 'unknown';

interface PlugPanel {
  key: string;
  name: string;
  description: string;
  review: hub.PlugReview | null;
  via: { orgId: string; orgName: string; connectionId: string } | null;
  live: RemoteMcpTool[] | null;
  liveError: string | null;
  state: State;
}

async function panels(): Promise<PlugPanel[]> {
  const actor = await platformActor();
  const plugs = hub.mcpPlugs(app());
  const health = await onboarding.listTenantHealth(app(), actor);
  // plug_reviews is a platform table every org may read and only the platform writes; read here outside any tenant.
  const reviews = await app().platform('platform: plug review page', (pctx) => hub.plugReviews({ db: pctx.db } as unknown as Ctx, plugs.map((p) => p.key)));
  const out: PlugPanel[] = [];
  for (const p of plugs) {
    const conn = health.flatMap((h) => h.connections.filter((c) => c.plugKey === p.key && c.status !== 'pending').map((c) => ({ orgId: h.orgId, orgName: h.name, connectionId: c.id }))).at(0) ?? null;
    let live: RemoteMcpTool[] | null = null;
    let liveError: string | null = null;
    if (conn) {
      try {
        live = await hub.fetchLiveTools(app(), conn.orgId, conn.connectionId);
      } catch (e) {
        liveError = (e as Error).message?.slice(0, 200) ?? 'unreachable';
      }
    }
    const review = reviews.get(p.key) ?? null;
    const state: State = live ? hub.checkPinned(review ?? undefined, live).state : 'unknown';
    out.push({ key: p.key, name: p.name, description: p.description, review, via: conn, live, liveError, state });
  }
  return out;
}

const STATE: Record<State, { tone: 'good' | 'bad' | 'warn' | 'neutral'; label: string }> = {
  pinned: { tone: 'good', label: 'Matches the review: offered' },
  changed: { tone: 'bad', label: 'Changed since review: withdrawn' },
  not_reviewed: { tone: 'warn', label: 'Never reviewed: withdrawn' },
  unknown: { tone: 'neutral', label: 'Live list not readable' },
};

/**
 * Remote plugs (docs/modules/hub.md): each plug's live tool list set against the one a person
 * reviewed, word for word. Any difference withdraws every tool of the plug until it is approved again.
 */
export default async function PlugsPage() {
  const list = await panels();
  return (
    <>
      <PageHeader title="Plug review" description="A remote service can change what its tools say after we read them. Anything different from the reviewed list keeps the whole plug switched off until someone reads it again here." />
      {list.length === 0 ? <EmptyState title="No remote plugs">No remote MCP plug is in the catalogue.</EmptyState> : null}
      <div className="grid gap-6">
        {list.map((p) => {
          const reviewed = new Map((p.review?.tools ?? []).map((t) => [t.name, t]));
          const liveNames = new Set((p.live ?? []).map((t) => t.name));
          const changed = new Set(p.live && p.review ? hub.checkPinned(p.review, p.live).state === 'changed' ? p.live.filter((t) => reviewed.get(t.name)?.digest !== hub.toolDigest(t)).map((t) => t.name) : [] : []);
          return (
            <Card key={p.key} title={p.name} description={p.description} actions={<Badge tone={STATE[p.state].tone}>{STATE[p.state].label}</Badge>}>
              <div data-testid={`plug-${p.key}`} data-state={p.state}>
                <p className="text-sm text-ink-2">
                  {p.review ? `Reviewed by ${p.review.reviewedBy} on ${dateTime(p.review.reviewedAt, 'Australia/Sydney')}: ${p.review.tools.length} tools.` : 'Never reviewed.'}{' '}
                  {p.via ? `Live list read through ${p.via.orgName}'s connection.` : 'No organisation has connected it, so its live list cannot be read yet.'}
                  {p.liveError ? ` Reading it failed: ${p.liveError}` : ''}
                </p>
                {p.live ? (
                  <ul className="mt-4 divide-y divide-line">
                    {p.live.map((t) => {
                      const was = reviewed.get(t.name);
                      const status = !was ? 'new' : changed.has(t.name) ? 'changed' : 'same';
                      return (
                        <li key={t.name} className="py-3" data-tool={t.name} data-diff={status}>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-medium">{t.name}</span>
                            {status === 'new' ? <Badge tone="bad">New since review</Badge> : status === 'changed' ? <Badge tone="bad">Changed since review</Badge> : <Badge tone="good">As reviewed</Badge>}
                            {t.annotations?.readOnlyHint ? <Badge>read-only</Badge> : <Badge tone="warn">can change things</Badge>}
                          </div>
                          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{t.description ?? '(no description)'}</p>
                          {status === 'changed' && was?.description !== t.description ? (
                            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-3 line-through">{was?.description ?? '(no description)'}</p>
                          ) : null}
                        </li>
                      );
                    })}
                    {[...reviewed.keys()]
                      .filter((n) => !liveNames.has(n))
                      .map((n) => (
                        <li key={n} className="py-3 text-sm text-ink-3">
                          <span className="font-mono">{n}</span> was reviewed but is not offered through this connection.
                        </li>
                      ))}
                  </ul>
                ) : null}
                {p.live && p.via && p.state !== 'pinned' ? (
                  <ActionForm action={approvePlugAction} className="mt-4">
                    <input type="hidden" name="plugKey" value={p.key} />
                    <input type="hidden" name="orgId" value={p.via.orgId} />
                    <input type="hidden" name="connectionId" value={p.via.connectionId} />
                    <SubmitButton pendingLabel="Approving…">I have read every tool above: approve this list</SubmitButton>
                  </ActionForm>
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
