import { encodeQr, qrPath } from '@/lib/site-qr';

/** A membership code as a QR code, drawn here as inline SVG: the code is never sent to anyone else's service. */
export function MemberQr({ code, label }: { code: string; label: string }) {
  const qr = encodeQr(code);
  const quiet = 4;
  const size = qr.size + quiet * 2;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={200} height={200} role="img" aria-label={label} shapeRendering="crispEdges" className="h-auto w-44 rounded bg-white p-0 sm:w-52" data-member-qr={code}>
      <rect width={size} height={size} fill="#ffffff" />
      <path d={qrPath(qr, quiet)} fill="#000000" />
    </svg>
  );
}
