import { redirect } from 'next/navigation';
import { hub } from '@ros/modules';
import { read } from '@/lib/console-read';
import { ActionForm, Badge, Card, Checkbox, EmptyState, LinkButton, PageHeader, Select } from '@/ui';
import { Facts } from '@/components/console/states';
import { decideOAuthAction } from './actions';
import { AnswerButtons } from './buttons';

export const metadata = { title: 'Connect an assistant · Restaurant OS' };

type SP = Record<string, string | string[] | undefined>;

/**
 * The consent page an assistant sends a person to when it asks to connect by sign-in. It shows
 * exactly who is asking, what it would be able to see, where, and for how long, and connects
 * nothing until the person says yes. Reading this page changes nothing.
 */
export default async function AuthorizeAssistant({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (v !== undefined) query.set(k, Array.isArray(v) ? (v[0] ?? '') : v);

  const review = await read((ctx) => hub.reviewOAuthRequest(ctx, query));
  if (!review.ok) {
    return (
      <>
        <PageHeader title="Connect an assistant" />
        <EmptyState title="Nothing was connected" action={<LinkButton href="/console/settings/assistants">Assistant access</LinkButton>}>
          {review.error}
        </EmptyState>
      </>
    );
  }
  // A request the assistant got wrong goes straight back to it with the reason; there is nothing to ask the person.
  if (review.data.outcome === 'return') redirect(review.data.redirectTo);
  const c = review.data;
  const lasts = [...new Set([7, 30, 90, 180, 365, c.lasts.defaultDays, c.lasts.maxDays])].filter((d) => d <= c.lasts.maxDays).sort((a, b) => a - b);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title="Connect an assistant?" description="An assistant is asking to connect to this organisation as you. Nothing is connected until you say yes." />

      <Card title="Who is asking">
        <Facts
          items={[
            ['Calls itself', <span key="n" data-testid="assistant-name">{c.assistant.name}</span>],
            ['Its website', c.assistant.website ?? 'None given'],
            ['After you answer, you go to', `${c.returnsTo.host}${c.returnsTo.thisComputer ? ' (a program on this computer)' : ''}`],
            ['Connecting as', `${c.account.person}, at ${c.account.org}`],
          ]}
        />
        <p className="mt-3 rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">
          The name and website are what the assistant says about itself; we cannot check them. Only continue if you started this from your own assistant just now.
        </p>
      </Card>

      <ActionForm action={decideOAuthAction} className="space-y-6">
        <input type="hidden" name="request" value={query.toString()} />

        <Card title="Where" description="It can never see a venue you cannot. Untick any it should not see.">
          <div className="space-y-2">
            {c.venues.map((v) => (
              <div key={v.id}>
                <input type="hidden" name="offeredVenue" value={v.id} />
                <Checkbox name="venue" value={v.id} defaultChecked label={v.name} hint={`Your role there: ${v.role.replace(/_/g, ' ')}`} />
              </div>
            ))}
          </div>
        </Card>

        <Card title="What it will be able to see" description="Totals and summaries only. It cannot read an individual guest's details through a sign-in.">
          <ScopeList scopes={c.scopes.read} />
        </Card>

        <Card
          title="Changes"
          description={
            !c.allowChanges.offered
              ? 'This assistant asked only to read, so it cannot propose changes.'
              : 'Off unless you tick the box. Even when ticked, every change waits for your own yes at the moment it is made.'
          }
        >
          {c.allowChanges.offered ? (
            <div className="space-y-3">
              <Checkbox
                name="allowChanges"
                disabled={!c.allowChanges.canTick}
                label="Allow this assistant to propose changes"
                hint={c.allowChanges.canTick ? 'It asks you first, every time, in plain words.' : 'Only an owner can allow an assistant to make changes.'}
              />
              <ScopeList scopes={c.scopes.changes} />
            </div>
          ) : (
            <Badge>Read only</Badge>
          )}
        </Card>

        <Card title="For how long">
          <label className="flex max-w-xs flex-col gap-1 text-sm font-medium text-ink">
            Stays connected for
            <Select name="lastsDays" defaultValue={c.lasts.defaultDays}>
              {lasts.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </Select>
          </label>
          <p className="mt-2 text-xs text-ink-3">
            You can end it at any time in Settings → Assistant access. Everything it does is recorded there under your name.
          </p>
        </Card>

        <AnswerButtons assistant={c.assistant.name} />
      </ActionForm>
    </div>
  );
}

function ScopeList({ scopes }: { scopes: Array<{ scope: string; tools: string[]; plug?: string }> }) {
  // A permission with no tools behind it yet (a service not connected) would unlock nothing.
  scopes = scopes.filter((s) => s.tools.length);
  if (!scopes.length) return <p className="text-sm text-ink-3">Nothing.</p>;
  return (
    <ul className="space-y-2 text-sm">
      {scopes.map((s) => (
        <li key={s.scope}>
          <span className="font-mono text-xs text-ink-3">{s.scope}</span>
          {s.plug ? <span className="ml-2 text-xs text-ink-3">through {s.plug}</span> : null}
          <span className="block text-ink">{s.tools.join(' · ')}</span>
        </li>
      ))}
    </ul>
  );
}
