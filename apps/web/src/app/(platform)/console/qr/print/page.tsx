import Link from 'next/link';
import { qr } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { EmptyState } from '@/ui';
import { PrintButton } from '@/components/console/print-button';
import { QrImage } from '@/components/console/qr-image';
import { siteBase } from '@/components/console/site-url';
import { ModuleOff, ReadError } from '@/components/console/states';

export const metadata = { title: 'Print QR codes · Pipedline' };

// Print: drop the console's navigation and page padding, one card per code, none split across pages.
const PRINT_CSS = `
@media print {
  @page { margin: 12mm; }
  body { background: #fff !important; }
  body > div:has(> aside) { display: block !important; }
  aside, [data-print-hide] { display: none !important; }
  main { padding: 0 !important; }
  [data-qr-card] { break-inside: avoid; border-color: #000 !important; }
}
`;

export default async function QrPrintPage({ searchParams }: { searchParams: Promise<{ kind?: string; batch?: string }> }) {
  const { kind, batch } = await searchParams;
  const c = await getConsole();
  if (!(await moduleOn('qr'))) return <ModuleOff title="QR codes" what="The QR menu" canManage={atLeast(c.role, 'manager')} />;
  const kindFilter = kind && ['menu', 'table', 'counter', 'campaign'].includes(kind) ? (kind as qr.QrCodeView['kind']) : undefined;
  const r = await read(async (ctx) => ({ codes: await qr.listQrCodes(ctx, { venueId: c.venue.id, kind: kindFilter }), base: await siteBase(ctx, c.venue.id) }));
  if (!r.ok) return <ReadError message={r.error} />;
  const natural = new Intl.Collator('en-AU', { numeric: true, sensitivity: 'base' });
  const order = ['menu', 'counter', 'table', 'campaign'];
  const codes = r.data.codes
    .filter((x) => !batch || x.printBatch === batch)
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || natural.compare(a.label ?? '', b.label ?? ''));

  return (
    <>
      <style>{PRINT_CSS}</style>
      <div data-print-hide className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm">
            <Link href="/console/qr" className="text-accent underline-offset-2 hover:underline">
              ← QR codes
            </Link>
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">Print sheet</h1>
          <p className="mt-1 text-sm text-ink-2">
            {codes.length} active {codes.length === 1 ? 'code' : 'codes'} for {c.venue.name}
            {batch ? `, batch “${batch}”` : ''}. Switched-off codes are left out.
          </p>
        </div>
        <PrintButton />
      </div>
      {codes.length === 0 ? (
        <EmptyState title="Nothing to print">There are no active codes here yet.</EmptyState>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 print:grid-cols-3">
          {codes.map((code) => (
            <li key={code.id} data-qr-card className="flex flex-col items-center rounded-lg border border-line bg-white p-4 text-center text-black">
              <QrImage value={`${r.data.base}${code.path}`} label={`QR code for ${code.label ?? code.kind}`} className="block aspect-square w-full max-w-44" />
              <p className="mt-2 text-lg font-semibold">{code.kind === 'table' ? `Table ${code.label}` : (code.label ?? (code.kind === 'campaign' ? (code.campaignId ?? 'Campaign') : c.venue.name))}</p>
              <p className="text-xs">Scan to see the menu{code.kind === 'table' || code.kind === 'counter' ? ' and order' : ''}</p>
              <p className="mt-1 break-all font-mono text-[10px] text-neutral-600">{`${r.data.base}${code.path}`}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
