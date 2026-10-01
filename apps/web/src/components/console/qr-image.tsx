import qrcode from 'qrcode-generator';

/**
 * A QR code drawn on the server as SVG elements (no image request, no markup string). The
 * matrix comes from qrcode-generator; error correction M survives a scuffed table sticker.
 */
export function qrPath(value: string): { size: number; d: string } {
  const qr = qrcode(0, 'M');
  qr.addData(value, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    }
  }
  // Four modules of quiet zone on every side, as the standard asks.
  return { size: n + 8, d };
}

export function QrImage({ value, label, className }: { value: string; label: string; className?: string }) {
  const { size, d } = qrPath(value);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className={className ?? 'block size-36'} shapeRendering="crispEdges" data-testid="qr-svg">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
