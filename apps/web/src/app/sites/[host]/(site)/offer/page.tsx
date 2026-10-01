import { redirect } from 'next/navigation';

/** A campaign code printed without a particular offer lands on the home page, keeping its parameters. */
export default async function OfferIndex({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = new URLSearchParams(Object.entries(await searchParams).filter((e): e is [string, string] => typeof e[1] === 'string'));
  redirect(q.size ? `/?${q}` : '/');
}
