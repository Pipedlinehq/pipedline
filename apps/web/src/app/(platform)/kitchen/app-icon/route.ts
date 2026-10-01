export const dynamic = 'force-static';

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#0b0d10"/><rect x="96" y="112" width="320" height="288" rx="24" fill="#1c2027" stroke="#facc15" stroke-width="16"/><path d="M144 184h224M144 248h160M144 312h192" stroke="#f8fafc" stroke-width="28" stroke-linecap="round"/></svg>`;

/** The installed kitchen app's icon. */
export function GET(): Response {
  return new Response(ICON, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
}
