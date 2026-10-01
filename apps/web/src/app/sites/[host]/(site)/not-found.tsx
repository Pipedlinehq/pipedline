import Link from 'next/link';

export default function SiteNotFound() {
  return (
    <div className="mx-auto max-w-xl space-y-4 px-4 py-24 text-center">
      {/* A page that was not found has no metadata of its own; every document still needs a title. */}
      <title>Page not found</title>
      <meta name="robots" content="noindex" />
      <h1 className="s-heading">We could not find that page</h1>
      <p>It may have moved, or the link may be incomplete.</p>
      <p className="flex flex-wrap justify-center gap-3">
        <Link href="/" className="s-btn">
          Go to the home page
        </Link>
        <Link href="/menu" className="s-btn-outline">
          See the menu
        </Link>
      </p>
    </div>
  );
}
