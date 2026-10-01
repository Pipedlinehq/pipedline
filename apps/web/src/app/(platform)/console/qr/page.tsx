import { qr } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ActionForm, Badge, Dialog, EmptyState, Field, Input, LinkButton, PageHeader, Select, SubmitButton, dateTime } from '@/ui';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { QrImage } from '@/components/console/qr-image';
import { siteBase } from '@/components/console/site-url';
import { ModuleOff, ReadError } from '@/components/console/states';
import { createCode, createTableCodes, deactivateCode, reactivateCode, updateCode } from './actions';

export const metadata = { title: 'QR codes · Pipedline' };

const KIND: Record<string, string> = { menu: 'Menu', table: 'Table', counter: 'Counter', campaign: 'Campaign' };

type Code = qr.QrCodeView;

function CodeFields({ code, withKind }: { code?: Code; withKind?: boolean }) {
  return (
    <div className="space-y-4">
      {withKind ? (
        <Field label="Kind" hint="A table or counter code carries its label into the order.">
          <Select name="kind" defaultValue="menu">
            <option value="menu">Menu (view the menu)</option>
            <option value="counter">Counter</option>
            <option value="table">Table</option>
            <option value="campaign">Campaign (flyer, a creator&apos;s post)</option>
          </Select>
        </Field>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Label" hint="“12”, “T4”, “Bar”.">
          <Input name="label" maxLength={40} defaultValue={code?.label ?? ''} />
        </Field>
        <Field label="Area">
          <Input name="area" maxLength={60} defaultValue={code?.area ?? ''} placeholder="Terrace" />
        </Field>
      </div>
      <Field label="Opens" hint="A page on the venue's own site.">
        <Input name="targetPath" defaultValue={code?.targetPath ?? '/menu'} required />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Campaign id" hint="Optional.">
          <Input name="campaignId" maxLength={100} defaultValue={code?.campaignId ?? ''} />
        </Field>
        <Field label="Creator id" hint="Optional.">
          <Input name="creatorId" maxLength={100} defaultValue={code?.creatorId ?? ''} />
        </Field>
      </div>
      <Field label="Print batch" hint="Optional, to print a set together.">
        <Input name="printBatch" maxLength={60} defaultValue={code?.printBatch ?? ''} />
      </Field>
    </div>
  );
}

export default async function QrPage({ searchParams }: { searchParams: Promise<{ inactive?: string; kind?: string }> }) {
  const { inactive, kind } = await searchParams;
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  if (!(await moduleOn('qr'))) return <ModuleOff title="QR codes" what="The QR menu" canManage={manager} />;
  const showInactive = inactive === '1';
  const kindFilter = kind && kind in KIND ? (kind as Code['kind']) : undefined;
  const r = await read(async (ctx) => ({
    codes: await qr.listQrCodes(ctx, { venueId: c.venue.id, includeInactive: showInactive, kind: kindFilter }),
    base: await siteBase(ctx, c.venue.id),
  }));
  if (!r.ok) {
    return (
      <>
        <PageHeader title="QR codes" />
        <ReadError message={r.error} />
      </>
    );
  }
  const natural = new Intl.Collator('en-AU', { numeric: true, sensitivity: 'base' });
  const order = ['menu', 'counter', 'table', 'campaign'];
  const codes = [...r.data.codes].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || natural.compare(a.label ?? '', b.label ?? ''));
  const { base } = r.data;
  const batches = [...new Set(codes.map((x) => x.printBatch).filter((b): b is string => !!b))];

  return (
    <>
      <PageHeader
        title="QR codes"
        description="Each code points at the venue's own site and is resolved there, so a changed menu, table or domain never means reprinting."
        actions={
          <>
            <LinkButton href={`/console/qr/print${kindFilter ? `?kind=${kindFilter}` : ''}`}>Print sheet</LinkButton>
            {manager ? (
              <>
                <Dialog trigger="Table codes" title="Codes for tables">
                  <ActionForm action={createTableCodes} resetOnSuccess>
                    <div className="space-y-4">
                      <Field label="Tables" hint="Ranges and names, separated by commas: 1-14, T1-T6, Bar. A table that has a code keeps it.">
                        <Input name="labels" required placeholder="1-14, T1-T6" />
                      </Field>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Area">
                          <Input name="area" maxLength={60} placeholder="Dining room" />
                        </Field>
                        <Field label="Print batch">
                          <Input name="printBatch" maxLength={60} placeholder="October reprint" />
                        </Field>
                      </div>
                    </div>
                    <div className="mt-4 flex justify-end">
                      <SubmitButton>Make codes</SubmitButton>
                    </div>
                  </ActionForm>
                </Dialog>
                <Dialog trigger="New code" title="New QR code" triggerVariant="primary">
                  <ActionForm action={createCode} resetOnSuccess>
                    <CodeFields withKind />
                    <div className="mt-4 flex justify-end">
                      <SubmitButton>Create code</SubmitButton>
                    </div>
                  </ActionForm>
                </Dialog>
              </>
            ) : null}
          </>
        }
      />

      <form method="get" className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
          Kind
          <select name="kind" defaultValue={kindFilter ?? ''} className="h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink">
            <option value="">All kinds</option>
            {Object.entries(KIND).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm text-ink">
          <input type="checkbox" name="inactive" value="1" defaultChecked={showInactive} className="size-4 accent-ink" />
          Include switched-off codes
        </label>
        <button type="submit" className="h-9 rounded-md border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-sunken">
          Show
        </button>
        {batches.length ? <p className="pb-2 text-xs text-ink-3">Print batches: {batches.join(', ')}</p> : null}
      </form>

      {codes.length === 0 ? (
        <EmptyState title="No codes yet">{manager ? 'Make one code per table with “Table codes”, or a general menu code with “New code”.' : 'A manager can make codes for this venue.'}</EmptyState>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3" data-testid="qr-list">
          {codes.map((code) => {
            const url = `${base}${code.path}`;
            return (
              <li key={code.id} data-testid={`qr-card-${code.id}`} className="flex flex-col rounded-lg border border-line bg-surface p-4">
                <div className="flex gap-4">
                <div className={code.isActive ? 'shrink-0' : 'shrink-0 opacity-40'}>
                  <QrImage value={url} label={`QR code for ${code.label ?? KIND[code.kind]}`} className="block size-28" />
                </div>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
                    {code.kind === 'table' ? `Table ${code.label}` : (code.label ?? KIND[code.kind])}
                    <Badge tone={code.isActive ? 'neutral' : 'bad'}>{code.isActive ? KIND[code.kind] : 'Switched off'}</Badge>
                  </p>
                  <p className="mt-1 break-all font-mono text-xs text-ink-2" data-testid="qr-url">
                    {url}
                  </p>
                  <p className="mt-1 text-xs text-ink-3">
                    Opens {code.targetPath}
                    {code.area ? ` · ${code.area}` : ''}
                    {code.campaignId ? ` · campaign ${code.campaignId}` : ''}
                    {code.creatorId ? ` · creator ${code.creatorId}` : ''}
                  </p>
                  <p className="mt-1 text-xs text-ink-3">
                    {code.scanCount.toLocaleString('en-AU')} {code.scanCount === 1 ? 'scan' : 'scans'}
                    {code.lastScannedAt ? `, last ${dateTime(code.lastScannedAt, c.venue.timezone)}` : ''}
                  </p>
                </div>
                </div>
                  {manager ? (
                    <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-line pt-3">
                      <Dialog trigger="Edit" title={`Edit ${code.label ?? code.code}`}>
                        <ActionForm action={updateCode}>
                          <input type="hidden" name="codeId" value={code.id} />
                          <CodeFields code={code} />
                          <div className="mt-4 flex justify-end">
                            <SubmitButton>Save</SubmitButton>
                          </div>
                        </ActionForm>
                      </Dialog>
                      {code.isActive ? (
                        <ConfirmAction trigger="Switch off" title="Switch this code off?" action={deactivateCode} hidden={{ codeId: code.id }} confirmLabel="Switch off" triggerSize="md">
                          Anyone scanning {code.kind === 'table' ? `table ${code.label}'s` : 'this'} code from now on is told it is no longer in use, and cannot order from it. Orders already placed keep their table. You can switch it back on.
                        </ConfirmAction>
                      ) : (
                        <InlineAction action={reactivateCode} hidden={{ codeId: code.id }} label="Switch on" />
                      )}
                    </div>
                  ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
