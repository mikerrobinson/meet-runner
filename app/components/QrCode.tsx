import { useMemo } from "react";
import qrcode from "qrcode-generator";

/**
 * A QR code as inline SVG.
 *
 * SVG rather than a canvas because this is meant to be printed and taped to a
 * timing table: it stays sharp at whatever size the printer feels like, and it
 * survives being screenshotted and pinched on a phone by a timer who couldn't
 * scan it from where they're standing.
 *
 * Error correction is set high. The thing this code lives on is a piece of
 * paper beside a pool, and it will get splashed.
 */
export function QrCode({
  value,
  size = 240,
  className = "",
}: {
  value: string;
  size?: number;
  className?: string;
}) {
  const { path, count } = useMemo(() => {
    // 0 picks the smallest symbol version the data fits into.
    const qr = qrcode(0, "H");
    qr.addData(value);
    qr.make();

    const modules = qr.getModuleCount();
    // One path for the whole code — thousands of <rect> elements is what makes
    // an inline QR feel slow on an old phone.
    let d = "";
    for (let row = 0; row < modules; row++) {
      for (let col = 0; col < modules; col++) {
        if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { path: d, count: modules };
  }, [value]);

  // A quiet zone is part of the spec, not decoration: scanners need the
  // border to find the code at all.
  const quiet = 2;
  const span = count + quiet * 2;

  return (
    <svg
      viewBox={`0 0 ${span} ${span}`}
      width={size}
      height={size}
      role="img"
      aria-label="QR code linking to the timing screen"
      className={className}
      shapeRendering="crispEdges"
    >
      <rect width={span} height={span} fill="#fff" />
      <path d={path} transform={`translate(${quiet} ${quiet})`} fill="#000" />
    </svg>
  );
}
