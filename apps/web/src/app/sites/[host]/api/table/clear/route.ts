import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import { getSite } from '@/lib/site';
import { TABLE_COOKIE } from '@/lib/site-table';

/** "I am not at this table": forget the scanned table and go back to the ordinary menu. */
export const POST = route(async (req, { params }: { params: Promise<{ host: string }> }) => {
  await getSite((await params).host);
  const back = new URL(req.url).searchParams.get('to') ?? '/menu';
  const to = /^\/(?!\/)[A-Za-z0-9/_-]*$/.test(back) ? back : '/menu';
  const res = new NextResponse(null, { status: 303, headers: { location: to } });
  res.cookies.delete(TABLE_COOKIE);
  return res;
});
