import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { ModuleOff, NotForYourRole } from '@/components/console/states';
import { Card, LinkButton, PageHeader } from '@/ui';
import { OfferForm } from '../offer-form';

export const metadata = { title: 'New offer · Restaurant OS' };

export default async function NewOfferPage() {
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  if (!(await moduleOn('offers'))) return <ModuleOff title="New offer" what="Offers" canManage={manager} />;
  if (!manager) return <NotForYourRole title="New offer">Only a manager or the owner can create offers.</NotForYourRole>;
  return (
    <>
      <PageHeader title="New offer" description="Offers apply across the organisation unless limited to venues." actions={<LinkButton href="/console/offers" size="sm">Back</LinkButton>} />
      <Card>
        <OfferForm c={c} />
      </Card>
    </>
  );
}
