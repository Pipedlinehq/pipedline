import { getModule } from '@ros/core';
import { website } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ActionForm, Card, Checkbox, Field, Input, Select, SubmitButton, Textarea } from '@/ui';
import { BLOCK_LABELS } from '@/components/console/block-form';
import { ModuleOff, NotForYourRole, ReadError } from '@/components/console/states';
import { WebsiteFrame } from '@/components/console/website-frame';
import { saveSettings } from '../actions';

export const metadata = { title: 'Website settings · Restaurant OS' };

const SOCIAL: Array<[string, string, string]> = [
  ['instagram', 'Instagram', 'https://www.instagram.com/…'],
  ['facebook', 'Facebook', 'https://www.facebook.com/…'],
  ['tiktok', 'TikTok', 'https://www.tiktok.com/@…'],
  ['x', 'X', 'https://x.com/…'],
  ['youtube', 'YouTube', 'https://www.youtube.com/…'],
  ['tripadvisor', 'Tripadvisor', 'https://www.tripadvisor.com.au/…'],
  ['googleBusiness', 'Google Business Profile', 'https://g.page/…'],
];

export default async function WebsiteSettingsPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Website">The website is edited by a manager.</NotForYourRole>;
  if (!(await moduleOn('website'))) return <ModuleOff title="Website" what="The website" canManage />;
  const r = await read(async (ctx) => (await getModule(ctx, c.venue.id, website.websiteModule)).config);
  const frame = { current: '/console/website/settings', site: 'org' as const, venueName: c.venue.name, orgName: c.org.tradingName, multi: c.venues.length > 1 };
  if (!r.ok) {
    return (
      <WebsiteFrame {...frame} title="Website settings">
        <ReadError message={r.error} />
      </WebsiteFrame>
    );
  }
  const cfg = r.data;
  const social = cfg.socialLinks as Record<string, string | null>;

  return (
    <WebsiteFrame {...frame} title="Website settings" description={`How ${c.venue.name}'s site behaves. To switch the website off, use Settings → Features.`}>
      <ActionForm action={saveSettings}>
        <div className="grid gap-6 xl:grid-cols-2">
          <Card title="Layout and sections">
            <div className="space-y-4">
              <Field label="Layout" hint="A venue may use its own layout; otherwise it follows the brand.">
                <Select name="skeleton" defaultValue={cfg.skeleton ?? ''}>
                  <option value="">Follow the brand</option>
                  {website.listSkeletons().map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-ink">Sections shown</legend>
                <p className="mb-2 text-xs text-ink-3">A section kind switched off here stays on its pages but is hidden.</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {website.BLOCK_TYPES.map((t) => (
                    <Checkbox key={t} name="enabledBlocks" value={t} label={BLOCK_LABELS[t]} defaultChecked={cfg.enabledBlocks.includes(t)} />
                  ))}
                </div>
              </fieldset>
              <Field label="Navigation" hint="One link per line: Label | /page. Leave empty to use the layout's own.">
                <Textarea name="navItems" rows={5} className="font-mono text-xs" defaultValue={cfg.navItems?.map((n) => `${n.label} | ${n.href}`).join('\n') ?? ''} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="“Book” buttons go to" hint="A page here or an https:// address.">
                  <Input name="bookingCtaTarget" defaultValue={cfg.bookingCtaTarget ?? ''} />
                </Field>
                <Field label="“Order” buttons go to">
                  <Input name="orderCtaTarget" defaultValue={cfg.orderCtaTarget ?? ''} />
                </Field>
              </div>
            </div>
          </Card>
          <div className="space-y-6">
            <Card title="Social profiles" description="Each is accepted only on its own site.">
              <div className="grid gap-3 sm:grid-cols-2">
                {SOCIAL.map(([k, label, ph]) => (
                  <Field key={k} label={label}>
                    <Input name={`social.${k}`} type="url" placeholder={ph} defaultValue={social[k] ?? ''} />
                  </Field>
                ))}
              </div>
            </Card>
            <Card title="Measurement tags" description="Ids only: the platform writes each tag itself, so nothing pasted here can run on the site.">
              <div className="space-y-3">
                <Field label="Google Analytics id" hint="Looks like G-AB12CD34EF.">
                  <Input name="googleAnalyticsId" defaultValue={cfg.integrations.googleAnalyticsId ?? ''} />
                </Field>
                <Field label="Meta pixel id" hint="10 to 20 digits.">
                  <Input name="metaPixelId" inputMode="numeric" defaultValue={cfg.integrations.metaPixelId ?? ''} />
                </Field>
                <Field label="Google Search Console code" hint="Only the code from the verification tag.">
                  <Input name="googleSiteVerification" defaultValue={cfg.integrations.googleSiteVerification ?? ''} />
                </Field>
              </div>
            </Card>
          </div>
        </div>
        <div className="mt-6 flex justify-end">
          <SubmitButton>Save settings</SubmitButton>
        </div>
      </ActionForm>
    </WebsiteFrame>
  );
}
