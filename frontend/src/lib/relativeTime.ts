/** How a moment reads next to "now": minutes, hours or days while it is recent, a plain date once it is more than a week away. Never guesses: no date, no text. */
export type Relative = { kind: 'now' | 'relative' | 'date'; future: boolean; text: string }
const JUST_NOW: Record<string, string> = { en: 'just now', ar: 'قبل لحظات', nl: 'zojuist' }
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR

export function relativeTime(iso: string | null | undefined, language: string, now: number = Date.now()): Relative | null {
  if (!iso) return null
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return null
  const diff = at - now, span = Math.abs(diff), future = diff > 0
  if (span < MINUTE) return { kind: 'now', future, text: JUST_NOW[language] ?? JUST_NOW.en }
  if (span > 7 * DAY) return { kind: 'date', future, text: new Date(at).toLocaleDateString(language, { dateStyle: 'medium' }) }
  const [unit, size] = span < HOUR ? (['minute', MINUTE] as const) : span < DAY ? (['hour', HOUR] as const) : (['day', DAY] as const)
  const amount = (future ? Math.ceil : Math.floor)(span / size)
  return { kind: 'relative', future, text: new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(future ? amount : -amount, unit) }
}
