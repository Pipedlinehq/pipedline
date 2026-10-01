import { ContentRoute, type SearchParams, contentMetadata } from '@/components/site/site-pages';

type Params = Promise<{ host: string; venue: string; path: string[] }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { host, venue, path } = await params;
  return contentMetadata(host, venue, path);
}

export default async function VenueContentPage({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  const { host, venue, path } = await params;
  return <ContentRoute host={host} venueSlug={venue} path={path} searchParams={await searchParams} />;
}
