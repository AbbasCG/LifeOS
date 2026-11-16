import type { HijriInfo } from '../lib/useHijri'

/**
 * A quiet Hijri date (full label, or just its day number in a small cell) and, on an Islamic day, its name in words.
 * Screen readers always get the full date; the number alone is only for the eye.
 */
export function HijriNote({ info, compact }: { info: HijriInfo | null; compact?: boolean }) {
  if (!info) return null
  return <small className="hijri" title={info.label}>
    {compact ? <><span aria-hidden="true">{info.day}</span><span className="sr-only">{info.label}</span></> : <bdi>{info.label}</bdi>}
    {info.special && <b className="hijri-special">{info.special}</b>}
  </small>
}
