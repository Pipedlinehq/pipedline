import type { analytics } from '@ros/modules';
import { Badge, Table, Td, Th } from '@/ui';
import { dateTime } from '@/ui/format';
import { show, words } from '@/lib/console-analytics';
import { Caveats, dateRange } from '../provenance';
import { SignificanceBadge } from './blocks';

const KIND = { day: 'Day', week: 'Week', month: 'Month' } as const;

/** One finding as a sentence a manager can act on. Arithmetic and templates only, like the digest itself. */
function sentence(f: analytics.DigestFinding, currency: string): string {
  const v = show(f.value, f.unit, currency);
  if (f.baseline === null || f.significance === 'insufficient_history') return `${f.name}: ${v}. Not enough history yet to say what is usual.`;
  const usual = show(f.baseline, f.unit, currency);
  if (f.direction === 'flat') return `${f.name}: ${v}, in line with the usual ${usual}.`;
  const by = f.change_pct === null ? '' : ` ${Math.abs(Math.round(f.change_pct * 1000) / 10)}%`;
  const verdict = f.reads_as === 'good' ? 'good news' : f.reads_as === 'bad' ? 'worth a look' : 'neither good nor bad in itself';
  return `${f.name}: ${v},${by} ${f.direction === 'up' ? 'above' : 'below'} the usual ${usual} (${verdict}).`;
}

/** A stored digest: the plain-language findings first, then the numbers behind them. */
export function DigestFindings({ digest, timeZone, compact = false }: { digest: analytics.StoredDigest; timeZone: string; compact?: boolean }) {
  const flagged = digest.headline.filter((f) => f.significance === 'notable' || f.significance === 'strong');
  return (
    <article className="rounded-lg border border-line bg-surface p-5" data-testid="digest">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-ink">
            {KIND[digest.period.kind]} of {dateRange(digest.period.from, digest.period.to)}
            {digest.venue ? ` · ${digest.venue}` : ''}
          </p>
          <p className="text-xs text-ink-3">Written {dateTime(digest.generated_at, timeZone)}{digest.period.complete ? '' : ' · period still in progress'}</p>
        </div>
        {flagged.length ? <Badge tone="accent">{flagged.length} beyond normal variation</Badge> : <Badge>Nothing unusual</Badge>}
      </header>
      <p className="mt-3 text-sm leading-relaxed text-ink">{digest.summary}</p>
      {flagged.length ? (
        <ul className="mt-3 space-y-1.5 text-sm text-ink">
          {flagged.map((f) => (
            <li key={f.metric} className="flex flex-wrap items-center gap-2">
              <SignificanceBadge s={f.significance} />
              <span>{sentence(f, digest.currency)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {compact ? null : (
        <>
          <h3 className="mt-5 text-sm font-semibold text-ink">Every headline figure against its usual</h3>
          <Table className="mt-2">
            <thead>
              <tr>
                <Th>Metric</Th>
                <Th align="right">This {digest.period.kind}</Th>
                <Th align="right">Usual</Th>
                <Th align="right">Usual range</Th>
                <Th align="right">Change</Th>
                <Th>Reading</Th>
              </tr>
            </thead>
            <tbody>
              {digest.headline.map((f) => (
                <tr key={f.metric}>
                  <Td>{f.name}</Td>
                  <Td numeric>{show(f.value, f.unit, digest.currency)}</Td>
                  <Td numeric>{show(f.baseline, f.unit, digest.currency)}</Td>
                  <Td numeric className="text-ink-2">
                    {f.usual_range ? `${show(f.usual_range[0], f.unit, digest.currency)} – ${show(f.usual_range[1], f.unit, digest.currency)}` : '–'}
                  </Td>
                  <Td numeric>{f.change_pct === null ? '–' : `${f.change_pct > 0 ? '+' : ''}${(f.change_pct * 100).toFixed(1)}%`}</Td>
                  <Td>
                    <SignificanceBadge s={f.significance} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {digest.movers.length ? (
            <>
              <h3 className="mt-5 text-sm font-semibold text-ink">What moved most</h3>
              <Table className="mt-2">
                <thead>
                  <tr>
                    <Th>By</Th>
                    <Th>What</Th>
                    <Th align="right">This {digest.period.kind}</Th>
                    <Th align="right">Usual</Th>
                    <Th align="right">Change</Th>
                  </tr>
                </thead>
                <tbody>
                  {digest.movers.map((m, i) => (
                    <tr key={i}>
                      <Td>{words(m.dimension)}</Td>
                      <Td>{words(m.member)}</Td>
                      <Td numeric>{show(m.value, m.unit, digest.currency)}</Td>
                      <Td numeric>{show(m.baseline, m.unit, digest.currency)}</Td>
                      <Td numeric>
                        {m.change_abs > 0 ? '+' : '−'}
                        {show(Math.abs(m.change_abs), m.unit, digest.currency)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          ) : null}
          <p className="mt-4 text-xs text-ink-3">How “usual” is worked out: {digest.baseline.method}</p>
        </>
      )}
      <Caveats items={digest.caveats} />
    </article>
  );
}
