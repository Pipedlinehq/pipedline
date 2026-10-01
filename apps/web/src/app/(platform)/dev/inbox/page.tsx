import { requireSim } from '@/lib/dev';
import { Card, PageHeader } from '@/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Simulated inbox · Pipedline' };

/** Every email and SMS the simulated providers "sent", newest first. Development only. */
export default function DevInboxPage() {
  const s = requireSim();
  const all = [...s.email.sent.map((m) => ({ ...m, via: 'Email' })), ...s.sms.sent.map((m) => ({ ...m, via: 'SMS' }))].sort((a, b) => b.at.getTime() - a.at.getTime());
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader title="Simulated inbox" description="Nothing here left the building. These are the messages the simulated email and SMS providers accepted." />
      {all.length === 0 ? (
        <p className="text-sm text-ink-2">No messages yet.</p>
      ) : (
        <ul className="space-y-3">
          {all.slice(0, 100).map((m) => (
            <li key={m.providerMessageId}>
              <Card>
                <p className="text-xs text-ink-3">
                  {m.via} · {m.kind} · to <span data-testid="to">{m.to}</span> · {m.at.toISOString()}
                </p>
                {m.subject ? <p className="mt-1 font-medium">{m.subject}</p> : null}
                <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm text-ink-2">{m.body}</pre>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
