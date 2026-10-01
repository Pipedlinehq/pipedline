import Link from 'next/link';
import { redirect } from 'next/navigation';
import { identity, loyalty, offers, ordering } from '@ros/modules';
import { SiteActionForm, SiteSubmit } from '@/components/site/action-form';
import { ORDER_STATUS_WORDS, dateTimeIn, money } from '@/components/site/format';
import { MemberQr } from '@/components/site/member-qr';
import { getVisitor } from '@/lib/site';
import { loadScope, optional, siteCall } from '@/lib/site-scope';
import { guestSignOut } from './actions';
import { cancelCounterCode, deleteAccount, getCounterCode, joinProgram, setConsent, updateProfile } from './guest-actions';

export const metadata = { title: 'Your account', robots: { index: false, follow: false } };

const CONSENT_TITLES: Record<string, string> = {
  marketing_email: 'Offers and news by email',
  marketing_sms: 'Offers and news by text message',
  card_recognition: 'Recognise my card',
  ad_platform_sharing: 'Help measure this venue’s advertising',
};

const KIND_WORDS: Record<string, string> = { earn: 'Earned', burn: 'Spent', bonus: 'Bonus', expire: 'Expired', reverse: 'Returned', transfer: 'Moved', adjust: 'Adjusted' };

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="s-card scroll-mt-24 space-y-4 p-5 sm:p-6">
      <h2 id={`${id}-h`} className="s-heading text-2xl">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function AccountPage({ params, searchParams }: { params: Promise<{ host: string }>; searchParams: Promise<{ history?: string }> }) {
  const { host } = await params;
  const { history } = await searchParams;
  const scope = await loadScope(host);
  const { customerId } = await getVisitor(scope.site.orgId);
  if (!customerId) redirect('/account/login');
  const tz = scope.venue?.timezone ?? scope.view.venues[0]?.timezone ?? 'Australia/Sydney';

  const data = await siteCall(host, async (ctx) => {
    const customer = await optional(identity.getCustomer(ctx, customerId));
    if (!customer) return null;
    const [orders, mine, codes, consents, wordings] = [
      await ordering.listMyOrders(ctx, { limit: 20 }),
      await optional(loyalty.getMyLoyalty(ctx, { venueId: scope.venue?.id ?? null })),
      await optional(offers.listMyCodes(ctx)),
      await identity.getConsents(ctx, customerId),
      await identity.currentWordings(ctx),
    ];
    const fullHistory = history === 'all' && mine?.member ? await loyalty.getMyLoyaltyHistory(ctx, { limit: 200 }) : null;
    return { customer, orders, mine, codes, consents, wordings, fullHistory };
  });
  // The session outlived the record (erased elsewhere): start again.
  if (!data) redirect('/account/login');
  const { customer, orders, mine, codes, consents, wordings, fullHistory } = data;
  const venueName = (id: string) => scope.view.venues.find((v) => v.id === id)?.name ?? '';
  const redeemVenues = scope.venue ? [scope.venue] : scope.view.venues;
  const member = mine?.member ?? null;
  const shownHistory = fullHistory ?? mine?.history ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="s-heading">{customer.firstName ? `Hi, ${customer.firstName}` : 'Your account'}</h1>
          <p>{[customer.email, customer.phone].filter(Boolean).join(' · ')}</p>
        </div>
        <form action={guestSignOut}>
          <button type="submit" className="s-btn-outline">
            Sign out
          </button>
        </form>
      </div>
      <nav aria-label="Account sections" className="flex flex-wrap gap-2">
        {[
          ['loyalty', 'Rewards'],
          ['orders', 'Orders'],
          ['codes', 'Offers'],
          ['profile', 'Profile'],
          ['privacy', 'Privacy'],
          ['data', 'Your data'],
        ].map(([id, label]) => (
          <a key={id} href={`#${id}`} className="s-pill no-underline hover:underline">
            {label}
          </a>
        ))}
      </nav>

      {mine?.program ? (
        <Section id="loyalty" title={mine.program.name}>
          {member ? (
            <>
              <div className="grid gap-6 sm:grid-cols-[auto_1fr] sm:items-center">
                <div className="flex flex-col items-center gap-2">
                  <MemberQr code={member.memberCode} label={`Membership code ${member.memberCode}`} />
                  <p className="s-tabular text-sm font-semibold" data-member-code>
                    {member.memberCode}
                  </p>
                </div>
                <div className="space-y-2">
                  <p className="text-4xl font-semibold s-tabular" data-points-balance={member.balance}>
                    {member.available.toLocaleString('en-AU')} <span className="text-lg font-normal">points to spend</span>
                  </p>
                  {member.held ? <p className="text-sm">{member.held} more are held for a counter code you have not used yet.</p> : null}
                  {member.tier ? <p>
                      Tier: <strong>{member.tier.name}</strong>
                    </p> : null}
                  {member.nextTier ? (
                    <p className="text-sm">
                      {member.nextTier.pointsToGo.toLocaleString('en-AU')} points to {member.nextTier.name}.
                    </p>
                  ) : null}
                  <p className="text-sm">Show this code at the counter to earn points on in-venue visits.</p>
                </div>
              </div>

              {mine.liveRedemptions.length ? (
                <div className="space-y-2">
                  <h3 className="s-heading text-xl">Codes ready to use</h3>
                  <ul className="space-y-2">
                    {mine.liveRedemptions.map((r) => (
                      <li key={r.id} className="s-notice flex flex-wrap items-center justify-between gap-3" data-redemption-code={r.code}>
                        <span>
                          <span className="s-tabular block text-2xl font-semibold tracking-widest">{r.code}</span>
                          {r.rewardName}: {r.rewardSummary}. Show it at the counter before {dateTimeIn(r.expiresAt, tz)}.
                        </span>
                        <SiteActionForm action={cancelCounterCode.bind(null, host)}>
                          <input type="hidden" name="redemptionId" value={r.id} />
                          <SiteSubmit className="s-btn-quiet" pending="Cancelling…">
                            Cancel code
                          </SiteSubmit>
                        </SiteActionForm>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="space-y-3">
                <h3 className="s-heading text-xl">Rewards</h3>
                <ul className="divide-y divide-[var(--brand-color-border)]">
                  {mine.rewards.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <span>
                        <span className="block font-semibold">{r.name}</span>
                        <span className="block text-sm">
                          {r.costPoints.toLocaleString('en-AU')} points{r.description ? ` · ${r.description}` : ''}
                          {!r.canAfford ? ` · ${r.pointsShort.toLocaleString('en-AU')} more points needed` : ''}
                          {r.blockedReason ? ` · ${r.blockedReason}` : ''}
                        </span>
                      </span>
                      {r.canAfford && !r.blockedReason ? (
                        <SiteActionForm action={getCounterCode.bind(null, host)} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="rewardId" value={r.id} />
                          {redeemVenues.length > 1 ? (
                            <select name="venueId" className="s-select w-auto" aria-label={`Where you will use ${r.name}`}>
                              {redeemVenues.map((v) => (
                                <option key={v.id} value={v.id}>
                                  {v.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input type="hidden" name="venueId" value={redeemVenues[0]?.id ?? ''} />
                          )}
                          <SiteSubmit className="s-btn-outline" pending="Getting code…">
                            Get a code for the counter
                          </SiteSubmit>
                        </SiteActionForm>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="text-sm">Ordering online? Use a reward at checkout instead; no code needed.</p>
              </div>

              <div className="space-y-2">
                <h3 className="s-heading text-xl">Points history</h3>
                {shownHistory.length ? (
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">Points history</caption>
                    <thead>
                      <tr>
                        <th scope="col" className="py-1 pr-3">
                          When
                        </th>
                        <th scope="col" className="py-1 pr-3">
                          What
                        </th>
                        <th scope="col" className="py-1 text-right">
                          Points
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownHistory.map((h) => (
                        <tr key={h.id} className="border-t s-rule">
                          <td className="py-1.5 pr-3 whitespace-nowrap">{dateTimeIn(h.occurredAt, tz)}</td>
                          <td className="py-1.5 pr-3">
                            {h.description}
                            {h.venueId && scope.view.venues.length > 1 ? ` · ${venueName(h.venueId)}` : ''}
                            <span className="sr-only"> ({KIND_WORDS[h.kind] ?? h.kind})</span>
                          </td>
                          <td className="s-tabular py-1.5 text-right font-semibold">{h.points > 0 ? `+${h.points}` : h.points}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-sm">No points yet.</p>
                )}
                {!fullHistory && shownHistory.length >= 25 ? (
                  <Link href="/account?history=all#loyalty" className="s-link text-sm">
                    Show all of it
                  </Link>
                ) : null}
              </div>
            </>
          ) : (
            <SiteActionForm action={joinProgram.bind(null, host, scope.venue?.id ?? null)} className="space-y-3">
              <p>You are not a member yet. Join to earn points on every order and visit{mine.program.enrolmentBonus ? `, with ${mine.program.enrolmentBonus} points to start` : ''}.</p>
              <SiteSubmit pending="Joining…">Join {mine.program.name}</SiteSubmit>
            </SiteActionForm>
          )}
        </Section>
      ) : null}

      <Section id="orders" title="Your orders">
        {orders.length ? (
          <ul className="divide-y divide-[var(--brand-color-border)]">
            {orders.map((o) => (
              <li key={o.reference + o.createdAt.toISOString()} className="flex flex-wrap items-start justify-between gap-3 py-3" data-order-ref={o.reference}>
                <span>
                  <span className="block font-semibold">
                    {dateTimeIn(o.createdAt, tz)} · {o.channel === 'dine-in-qr' ? `Table ${o.tableLabel ?? ''}` : o.channel === 'delivery' ? 'Delivery' : 'Pickup'}
                    {scope.view.venues.length > 1 ? ` · ${venueName(o.venueId)}` : ''}
                  </span>
                  <span className="block text-sm">{o.items.map((i) => `${i.qty} × ${i.name}`).join(', ')}</span>
                  <span className="block text-sm">
                    {ORDER_STATUS_WORDS[o.status] ?? o.status} · {money(o.totalCents, o.currency)}
                  </span>
                </span>
                <Link href={`/order/t/${o.trackingToken}`} className="s-link text-sm">
                  {o.status === 'pending_payment' ? 'Pay or cancel' : 'View'}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p>No orders yet.</p>
        )}
      </Section>

      <Section id="codes" title="Offers and codes">
        {codes === null ? (
          <p>This venue does not run offers at the moment.</p>
        ) : codes.length ? (
          <ul className="space-y-3">
            {codes.map((c) => (
              <li key={c.id} className="s-notice" data-offer-code={c.code}>
                <span className="block font-semibold">{c.offerName}</span>
                <span className="block">{c.summary}</span>
                <span className="s-tabular block text-lg font-semibold tracking-wider">{c.code}</span>
                <span className="block text-sm">
                  {c.status === 'issued' ? 'Not claimed yet. ' : ''}Use by {dateTimeIn(c.expiresAt, tz)}.{' '}
                  <Link href={`/order?code=${encodeURIComponent(c.code)}`} className="s-link">
                    Use it on an order
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No codes right now.</p>
        )}
      </Section>

      <Section id="profile" title="Profile">
        <SiteActionForm action={updateProfile.bind(null, host)} className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1">
            <span>First name</span>
            <input className="s-input" name="firstName" autoComplete="given-name" defaultValue={customer.firstName ?? ''} maxLength={100} />
          </label>
          <label className="block space-y-1">
            <span>Last name</span>
            <input className="s-input" name="lastName" autoComplete="family-name" defaultValue={customer.lastName ?? ''} maxLength={100} />
          </label>
          <label className="block space-y-1">
            <span>Birthday (optional, for a birthday treat)</span>
            <input className="s-input" type="date" name="birthday" defaultValue={customer.birthday ?? ''} />
          </label>
          <label className="block space-y-1 sm:col-span-2">
            <span>Allergies or dietary needs we should know about (optional)</span>
            <textarea className="s-textarea" name="allergyNotes" defaultValue={customer.allergyNotes ?? ''} maxLength={2000} />
          </label>
          <p className="text-sm sm:col-span-2">Your email and mobile are how you sign in. To change them, contact the venue.</p>
          <div>
            <SiteSubmit>Save</SiteSubmit>
          </div>
        </SiteActionForm>
      </Section>

      <Section id="privacy" title="Your choices">
        <p className="text-sm">Each is separate. Turning one on or off changes nothing else, and takes effect straight away.</p>
        <ul className="space-y-4">
          {consents.map((c) => {
            const w = wordings.find((x) => x.purpose === c.purpose)!;
            return (
              <li key={c.purpose} className="border-t pt-4 s-rule" data-consent-row={c.purpose} data-granted={c.granted ? 'yes' : 'no'}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="font-semibold">
                      {CONSENT_TITLES[c.purpose] ?? c.purpose}: <span>{c.granted ? 'On' : 'Off'}</span>
                    </p>
                    <p className="text-sm">{w.body}</p>
                    {c.granted && c.at ? <p className="text-sm">You agreed on {dateTimeIn(c.at, tz)}.</p> : null}
                  </div>
                  <SiteActionForm action={setConsent.bind(null, host)}>
                    <input type="hidden" name="purpose" value={c.purpose} />
                    <input type="hidden" name="version" value={w.version} />
                    <input type="hidden" name="action" value={c.granted ? 'revoke' : 'grant'} />
                    <SiteSubmit className={c.granted ? 's-btn-outline' : 's-btn'} pending="Saving…">
                      {c.granted ? 'Withdraw' : 'Turn on'}
                    </SiteSubmit>
                  </SiteActionForm>
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section id="data" title="Your data">
        <form method="post" action="/account/export" className="space-y-2">
          <p>Download everything {scope.view.org.name} holds about you, as a file.</p>
          <button type="submit" className="s-btn-outline">
            Download my data
          </button>
        </form>
        <details className="border-t pt-4 s-rule">
          <summary className="cursor-pointer font-semibold">Delete my account</summary>
          <SiteActionForm action={deleteAccount.bind(null, host)} className="mt-3 space-y-3">
            <p>
              This removes your name, email, mobile, birthday, choices and loyalty membership, and signs you out. Your points and any codes will be gone and cannot be restored. The venue keeps its sales records without your name.
            </p>
            <label className="block space-y-1">
              <span>Type DELETE to confirm</span>
              <input className="s-input" name="confirm" autoComplete="off" required />
            </label>
            <SiteSubmit className="s-btn" pending="Deleting…">
              Delete my account
            </SiteSubmit>
          </SiteActionForm>
        </details>
      </Section>
    </div>
  );
}
