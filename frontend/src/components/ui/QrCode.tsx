import { useMemo } from 'react'
import { encodeQr } from '../../lib/qr'

/** Renders text as an SVG QR code (always dark on light, with the required quiet zone). */
export default function QrCode({ value, size = 200, label }: { value: string; size?: number; label: string }) {
  const { path, dimension } = useMemo(() => {
    const modules = encodeQr(value, 'M'), quiet = 4
    let d = ''
    modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + quiet} ${y + quiet}h1v1h-1z` }))
    return { path: d, dimension: modules.length + quiet * 2 }
  }, [value])
  return <svg className="qr-code" role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${dimension} ${dimension}`} shapeRendering="crispEdges"><rect width={dimension} height={dimension} fill="#fff" /><path d={path} fill="#000" /></svg>
}
