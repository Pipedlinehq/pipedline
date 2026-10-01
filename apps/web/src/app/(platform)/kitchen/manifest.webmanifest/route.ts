export const dynamic = 'force-static';

/** Makes the kitchen screen installable: full screen, landscape, dark, opening straight on /kitchen. */
export function GET(): Response {
  const manifest = {
    name: 'Kitchen orders',
    short_name: 'Kitchen',
    description: 'The kitchen order screen for a paired venue.',
    id: '/kitchen',
    start_url: '/kitchen',
    scope: '/kitchen',
    display: 'fullscreen',
    orientation: 'landscape',
    background_color: '#0b0d10',
    theme_color: '#0b0d10',
    icons: [{ src: '/kitchen/app-icon', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
  return new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=3600' } });
}
