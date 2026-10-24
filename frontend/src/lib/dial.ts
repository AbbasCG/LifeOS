/** Geometry for the 24-hour day dial (viewBox 220×220). */
const C = 110
const DAY = 86_400_000

/** Point on a circle where 0° is midnight at the top and angles grow clockwise. */
export function polar(r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180
  return [C + r * Math.sin(rad), C - r * Math.cos(rad)]
}

export function arcPath(r: number, from: number, to: number): string {
  const end = Math.max(to, from + 1.2)
  const [x1, y1] = polar(r, from), [x2, y2] = polar(r, Math.min(end, from + 359.9))
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${end - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
}

/** Angle of an instant within the local day that starts at `dayStart` (clamped to the day). */
export function dayAngle(iso: string | number, dayStart: number): number {
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime()
  return Math.max(0, Math.min(360, ((t - dayStart) / DAY) * 360))
}


/** True when the browser knows this IANA timezone (old browsers may not). */
export function isValidZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true } catch { return false }
}
