import { comms, tenancy } from '@ros/modules';
import { app } from '@/lib/runtime';
import { getSite } from '@/lib/site';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Unsubscribe', robots: { index: false } };

/** One step, no sign-in: the link in the email is the proof. */
export default async function UnsubscribePage({ params }: { params: Promise<{ host: string; token: string }> }) {
  const { host, token } = await params;
  const site = await getSite(host);
  const result = await comms.unsubscribeByToken(app(), site.orgId, decodeURIComponent(token));
  const org = await app().tenant(site.orgId, { kind: 'anon' }, (ctx) => tenancy.getOrg(ctx));
  return (
    <main style={{ maxWidth: '32rem', margin: '0 auto', padding: '4rem 1.5rem' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 600 }}>{result.ok ? 'You are unsubscribed' : 'That link did not work'}</h1>
      <p style={{ marginTop: '0.75rem' }}>
        {result.ok
          ? `${org.tradingName} will not send you marketing messages at this address again. Receipts and messages about an order you place will still reach you.`
          : `The link may be incomplete. Reply to any message from ${org.tradingName} and ask to be removed, or contact the venue directly.`}
      </p>
    </main>
  );
}
