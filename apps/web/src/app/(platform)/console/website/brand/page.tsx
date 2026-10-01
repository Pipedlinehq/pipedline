import { website } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ActionForm, Badge, Card, Field, Input, Select, SubmitButton, Textarea } from '@/ui';
import { ConfirmAction } from '@/components/console/confirm';
import { ModuleOff, NotForYourRole, ReadError } from '@/components/console/states';
import { WebsiteFrame, readSite } from '@/components/console/website-frame';
import { clearOverride, saveBrand } from '../actions';

export const metadata = { title: 'Brand · Restaurant OS' };

const COLOUR_LABELS: Array<[string, string]> = [
  ['primary', 'Primary'],
  ['primaryContrast', 'Text on primary'],
  ['secondary', 'Secondary'],
  ['accent', 'Accent'],
  ['surface', 'Page background'],
  ['surfaceAlt', 'Alternate background'],
  ['text', 'Text'],
  ['textMuted', 'Muted text'],
  ['border', 'Borders'],
  ['success', 'Success'],
  ['warning', 'Warning'],
  ['error', 'Error'],
];

export default async function BrandPage({ searchParams }: { searchParams: Promise<{ site?: string }> }) {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Website">The website is edited by a manager.</NotForYourRole>;
  if (!(await moduleOn('website'))) return <ModuleOff title="Website" what="The website" canManage />;
  const site = readSite((await searchParams).site, c.venues.length);
  const venueId = site === 'venue' ? c.venue.id : null;
  const r = await read((ctx) => website.getBrandForEdit(ctx, { venueId }));
  const frame = { current: '/console/website/brand', site, venueName: c.venue.name, orgName: c.org.tradingName, multi: c.venues.length > 1 };
  if (!r.ok) {
    return (
      <WebsiteFrame {...frame} title="Brand">
        <ReadError message={r.error} />
      </WebsiteFrame>
    );
  }
  const b = r.data;
  const t = b.effective.tokens;
  const colour = t.colour as Record<string, string>;
  const pairs = website.CONTRAST_PAIRS.map((p) => ({ ...p, ratio: website.contrastRatio(colour[p.fg]!, colour[p.bg]!) }));
  const fontOptions = website.FONTS.map((f) => (
    <option key={f.family} value={f.family}>
      {f.family} ({f.category})
    </option>
  ));

  return (
    <WebsiteFrame
      {...frame}
      title="Brand"
      description={
        venueId
          ? `${c.venue.name}'s own look: only what you change here differs from the group brand.`
          : 'Typefaces, colours and the layout every page of the site is drawn with. Colours must stay readable, or nothing is saved.'
      }
      actions={
        venueId && b.override ? (
          <ConfirmAction trigger="Follow the group brand" title="Remove this venue's own look?" action={clearOverride} confirmLabel="Remove override">
            {c.venue.name}&apos;s site goes back to the group&apos;s colours, typefaces and logo straight away.
          </ConfirmAction>
        ) : null
      }
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title={venueId ? `${c.venue.name}${b.override ? '' : ' (following the group)'}` : 'Brand'}>
          <ActionForm action={saveBrand}>
            <input type="hidden" name="site" value={site} />
            <div className="space-y-5">
              {venueId ? null : (
                <Field label="Layout" hint="The skeleton every page is laid out on.">
                  <Select name="skeleton" defaultValue={b.org.skeleton}>
                    {website.listSkeletons().map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Heading typeface">
                  <Select name="headingFamily" defaultValue={t.typography.heading.family}>
                    {fontOptions}
                  </Select>
                </Field>
                <Field label="Body typeface">
                  <Select name="bodyFamily" defaultValue={t.typography.body.family}>
                    {fontOptions}
                  </Select>
                </Field>
              </div>
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-ink">Colours</legend>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                  {COLOUR_LABELS.map(([k, label]) => (
                    <label key={k} className="flex items-center gap-2 text-sm text-ink">
                      <input type="color" name={`colour.${k}`} defaultValue={colour[k]!.toLowerCase()} className="h-9 w-10 shrink-0 cursor-pointer rounded border border-line-strong bg-surface" />
                      <span className="min-w-0">
                        <span className="block truncate">{label}</span>
                        <span className="block font-mono text-xs text-ink-3">{colour[k]}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Corner rounding (px)">
                  <Input name="radius" type="number" min={0} max={32} defaultValue={t.radius.md} />
                </Field>
                <Field label="Spacing">
                  <Select name="density" defaultValue={t.density}>
                    {website.DENSITIES.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Photo shape">
                  <Select name="imageRatio" defaultValue={t.imagery.ratio}>
                    {website.IMAGE_RATIOS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Photo tone">
                  <Select name="imageTreatment" defaultValue={t.imagery.treatment}>
                    {website.IMAGE_TREATMENTS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <input type="hidden" name="imageCorner" value={t.imagery.corner} />
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Logo (SVG)" hint="Optional address.">
                  <Input name="logoSvgUrl" defaultValue={(venueId ? b.override?.logo.svgUrl : b.org.logo.svgUrl) ?? ''} />
                </Field>
                <Field label="Logo (image)">
                  <Input name="logoRasterUrl" defaultValue={(venueId ? b.override?.logo.rasterUrl : b.org.logo.rasterUrl) ?? ''} />
                </Field>
                <Field label="Small mark">
                  <Input name="logoMarkUrl" defaultValue={(venueId ? b.override?.logo.markUrl : b.org.logo.markUrl) ?? ''} />
                </Field>
              </div>
              {venueId ? null : (
                <Field label="Tone of voice" hint="Three or four sentences in your own voice. Steers suggested copy; never shown on the site.">
                  <Textarea name="toneOfVoice" maxLength={1500} defaultValue={b.org.toneOfVoice ?? ''} />
                </Field>
              )}
            </div>
            <div className="mt-5 flex justify-end">
              <SubmitButton>Save brand</SubmitButton>
            </div>
          </ActionForm>
        </Card>

        <div className="space-y-4">
          <Card title="Readability" description="Text must stand out from what it sits on. Saved colours always pass.">
            <ul className="space-y-3">
              {pairs.map((p) => (
                <li key={p.label} className="flex items-center gap-3 text-sm">
                  <span className="flex h-9 w-14 shrink-0 items-center justify-center rounded border border-line text-sm font-semibold" style={{ background: colour[p.bg], color: colour[p.fg] }} aria-hidden>
                    Aa
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-ink">{p.label}</span>
                    <span className="text-xs text-ink-3">
                      {p.ratio.toFixed(1)}:1, needs {p.min}:1
                    </span>
                  </span>
                  <Badge tone={p.ratio >= p.min ? 'good' : 'bad'}>{p.ratio >= p.min ? 'Readable' : 'Too faint'}</Badge>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Preview">
            <div className="overflow-hidden rounded-md border" style={{ background: colour.surface, color: colour.text, borderColor: colour.border }}>
              <div className="px-4 py-5" style={{ background: colour.surfaceAlt }}>
                <p className="text-lg font-semibold" style={{ color: colour.primary }}>
                  {c.venue.name}
                </p>
                <p className="mt-1 text-sm" style={{ color: colour.textMuted }}>
                  {t.typography.heading.family} headings, {t.typography.body.family} text
                </p>
              </div>
              <div className="px-4 py-4">
                <span className="inline-block px-3 py-1.5 text-sm font-medium" style={{ background: colour.primary, color: colour.primaryContrast, borderRadius: t.radius.md }}>
                  Order now
                </span>
                {/* The accent as a swatch beside its name: as text on the surface it is often too pale to read. */}
                <span className="ml-2 inline-flex items-center gap-1.5 text-sm">
                  <span aria-hidden className="inline-block size-3 rounded-full" style={{ background: colour.accent }} />
                  Accent
                </span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </WebsiteFrame>
  );
}
