import { website } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ActionForm, Card, EmptyState, Field, Input, SubmitButton, dateTime } from '@/ui';
import { ConfirmAction } from '@/components/console/confirm';
import { unloadable } from '@/components/console/site-url';
import { ModuleOff, NotForYourRole, ReadError } from '@/components/console/states';
import { WebsiteFrame } from '@/components/console/website-frame';
import { removeMedia, setMediaAlt, uploadMedia } from '../actions';

export const metadata = { title: 'Media · Restaurant OS' };

const size = (bytes: number | null) => (bytes === null ? '' : bytes > 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1000)} KB`);

export default async function MediaPage() {
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Website">The website is edited by a manager.</NotForYourRole>;
  if (!(await moduleOn('website'))) return <ModuleOff title="Website" what="The website" canManage />;
  const r = await read((ctx) => website.listMedia(ctx, { limit: 200 }));
  const frame = { current: '/console/website/media', site: 'org' as const, venueName: c.venue.name, orgName: c.org.tradingName, multi: c.venues.length > 1 };

  return (
    <WebsiteFrame {...frame} title="Media" description="Photos for every site in the organisation. Use an image's address in a page section.">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div>
          {!r.ok ? (
            <ReadError message={r.error} />
          ) : r.data.length === 0 ? (
            <EmptyState title="No images yet">Upload a photo to use it on the site.</EmptyState>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2">
              {r.data.map((m) => (
                <li key={m.id} className="rounded-lg border border-line bg-surface p-3">
                  {unloadable(m.url) ? (
                    <div className="flex aspect-[4/3] items-center justify-center rounded-md bg-sunken text-xs text-ink-3">Preview not available here (simulated storage)</div>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- a media library shows the stored file as it is
                    <img src={m.url} alt={m.alt ?? ''} className="aspect-[4/3] w-full rounded-md bg-sunken object-cover" />
                  )}
                  <p className="mt-2 break-all font-mono text-xs text-ink-2">{m.url}</p>
                  <p className="mt-1 text-xs text-ink-3">
                    {[m.width && m.height ? `${m.width}×${m.height}` : null, size(m.bytes), dateTime(m.createdAt, c.venue.timezone, { date: true, time: false })].filter(Boolean).join(' · ')}
                  </p>
                  {/* Two forms side by side, never one inside the other: the dialog has a form of its own. */}
                  <ActionForm action={setMediaAlt} className="mt-2">
                    <input type="hidden" name="mediaId" value={m.id} />
                    <Field label="Description">
                      <Input name="alt" maxLength={200} defaultValue={m.alt ?? ''} />
                    </Field>
                    <div className="mt-2">
                      <SubmitButton size="sm" variant="secondary">
                        Save<span className="sr-only"> description</span>
                      </SubmitButton>
                    </div>
                  </ActionForm>
                  <div className="mt-2 flex justify-end">
                    <ConfirmAction trigger={<>Remove<span className="sr-only"> this image</span></>} title="Remove this image?" action={removeMedia} hidden={{ mediaId: m.id }} confirmLabel="Remove image" triggerVariant="ghost">
                      The image is deleted from the library and from storage. Any page section still pointing at it shows nothing in its place.
                    </ConfirmAction>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Card title="Upload" description="JPEG, PNG, WebP, AVIF or GIF, up to 8 MB.">
          <ActionForm action={uploadMedia} resetOnSuccess>
            <div className="space-y-3">
              <Field label="Image">
                <input type="file" name="file" accept="image/jpeg,image/png,image/webp,image/avif,image/gif" required className="block w-full text-sm text-ink-2 file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm" />
              </Field>
              <Field label="Description" hint="What the photo shows, for people who cannot see it.">
                <Input name="alt" maxLength={200} />
              </Field>
            </div>
            <div className="mt-4 flex justify-end">
              <SubmitButton pendingLabel="Uploading…">Upload</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      </div>
    </WebsiteFrame>
  );
}
