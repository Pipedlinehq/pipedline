import { NextResponse } from 'next/server';
import { ordering } from '@ros/modules';
import { route } from '@/lib/http';
import { asDevice } from '@/lib/ops-device';

export const dynamic = 'force-dynamic';

/**
 * GET /kitchen/api/tickets: the paired screen's live tickets. The venue is the screen's own; a
 * `venueId` naming another venue is answered as not found by the ordering service, never served.
 */
export const GET = route(async (req) => {
  const venueId = new URL(req.url).searchParams.get('venueId') ?? undefined;
  const board = await asDevice(req, (ctx) => ordering.listLiveTickets(ctx, { venueId }));
  return NextResponse.json(board, { headers: { 'cache-control': 'no-store' } });
});
