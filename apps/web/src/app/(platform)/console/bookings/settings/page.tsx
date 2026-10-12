import Link from 'next/link';
import { tenancy } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { formSpecFromJson, type JS } from '@/lib/console-schema-form';
import { ModuleSettingsForm } from '@/components/console/settings-form';
import { ModuleOff, NotForYourRole, ReadError } from '@/components/console/states';
import { Card, PageHeader } from '@/ui';
import { savePluginOptions } from '../../plugins/actions';

export const metadata = { title: 'Booking rules · Pipedline' };

/**
 * The booking rules: generated from the bookings module's config schema, so every setting and its
 * description are the module's own words (the same words an assistant reads in plugins_list).
 * Saving goes through tenancy.configurePlugin, which refuses a bad value and says which and why.
 */
export default async function BookingSettingsPage() {
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  if (!(await moduleOn('bookings'))) return <ModuleOff title="Booking rules" what="Table bookings" canManage={manager} />;
  if (!manager) return <NotForYourRole title="Booking rules">A manager sets the services, caps and cut-offs.</NotForYourRole>;
  const catalogue = await read((ctx) => tenancy.pluginCatalogueForVenue(ctx, c.venue.id));
  const entry = catalogue.ok ? catalogue.data.plugins.find((p) => p.key === 'bookings') : undefined;

  return (
    <>
      <PageHeader
        eyebrow="Bookings"
        title="Booking rules"
        description={`How ${c.venue.name} takes bookings: the services guests can book, how many covers each slot and service holds, how far ahead and how late guests may book, and whether a booking is confirmed on the spot or waits for your yes.`}
        actions={
          <Link href="/console/bookings" className="text-sm text-accent">
            Back to the book
          </Link>
        }
      />
      {!catalogue.ok ? (
        <ReadError message={catalogue.error} />
      ) : !entry?.config_schema ? (
        <ReadError message="Table bookings is not in the catalogue for this venue." />
      ) : (
        <Card>
          <ModuleSettingsForm moduleKey="bookings" fields={formSpecFromJson(entry.config_schema as JS, entry.config ?? {})} action={savePluginOptions} submitLabel="Save booking rules" />
          <p className="mt-4 text-xs text-ink-3">
            Leave the services table empty and bookings follow the opening hours, one service per opening period. Every rule here is checked before it is saved; a rule that cannot work is refused with the reason.
          </p>
        </Card>
      )}
    </>
  );
}
