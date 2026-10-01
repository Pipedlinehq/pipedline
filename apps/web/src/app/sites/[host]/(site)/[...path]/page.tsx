import { ContentRoute, type SearchParams, contentMetadata } from '@/components/site/site-pages';

type Params = Promise<{ host: string; path: string[] }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { host, path } = await params;
  return contentMetadata(host, null, path);
}

/** A published page by its address; else an old address from the redirect map; else 404. */
export default async function ContentPage({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  const { host, path } = await params;
  return <ContentRoute host={host} venueSlug={null} path={path} searchParams={await searchParams} />;
}
