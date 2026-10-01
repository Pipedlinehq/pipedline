import { isAppError } from '@ros/core';
import { ordering, tenancy } from '@ros/modules';
import { getDeviceSession } from '@/lib/ops-device';
import { app } from '@/lib/runtime';
import { KitchenScreen } from '@/components/kitchen/kitchen-screen';
import { PairForm, ScreenMessage } from '@/components/kitchen/pair-form';
import type { KBoard } from '@/components/kitchen/logic';
import { forgetPairing, pairScreen } from './actions';

export const dynamic = 'force-dynamic';

/**
 * The kitchen order screen. Unpaired (or revoked), it asks for a pairing code; paired, it shows
 * the venue's live tickets and keeps them current without a refresh.
 */
export default async function KitchenPage() {
  const session = await getDeviceSession();
  if (!session) return <PairForm action={pairScreen} />;
  if (session.principal.purpose !== 'kitchen') {
    return <ScreenMessage title="This is a counter screen" body="It was paired for the counter, not the kitchen. Pair it again with a kitchen code from the console." action={forgetPairing} actionLabel="Pair again" />;
  }
  try {
    const { board, venueName } = await app().tenant(session.orgId, session.principal, async (ctx) => ({
      board: await ordering.listLiveTickets(ctx, {}),
      venueName: (await tenancy.getVenue(ctx, session.principal.venueId)).name,
    }));
    const initial = JSON.parse(JSON.stringify(board)) as KBoard;
    return <KitchenScreen initial={initial} venueName={venueName} deviceId={session.principal.deviceId} />;
  } catch (e) {
    if (isAppError(e) && (e.code === 'module_disabled' || e.code === 'not_found')) {
      return <ScreenMessage title="Online ordering is switched off" body="This venue does not take orders through the platform right now, so there is nothing for this screen to show." />;
    }
    throw e;
  }
}
