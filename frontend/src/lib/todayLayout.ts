import { useEffect, useState } from 'react'

/** The sections at the top of Today (V22), in their default order. "now" can be moved but never hidden. */
export const TODAY_SECTIONS = ['now', 'strip', 'top3', 'progress', 'focus', 'habits', 'copilot', 'suggestions'] as const
export type TodaySection = typeof TODAY_SECTIONS[number]
export type Device = 'phone' | 'desktop'
export type SectionLayout = { order: TodaySection[]; hidden: TodaySection[] }
export type TodayLayout = Partial<Record<Device, Partial<SectionLayout>>>

/** Sections that take half the width on larger screens; the rest span the full width. */
export const HALF_WIDTH: TodaySection[] = ['top3', 'progress', 'focus', 'habits']

/** Sections added later start hidden, so nobody's Today changes until they choose to show them (V24: focus). */
export const DEFAULT_HIDDEN: TodaySection[] = ['focus']

const known = (s: unknown): s is TodaySection => TODAY_SECTIONS.includes(s as TodaySection)

/** A saved layout made safe: unknown sections dropped, missing ones appended in default order, "now" always shown. */
export function normalizeToday(saved?: Partial<SectionLayout> | null): SectionLayout {
  const order = [...new Set((saved?.order ?? []).filter(known))]
  const hidden: TodaySection[] = [...new Set((saved?.hidden ?? []).filter(known))].filter(s => s !== 'now')
  // A section the saved layout has never seen is appended and keeps its default visibility.
  for (const s of TODAY_SECTIONS) if (!order.includes(s)) { order.push(s); if (DEFAULT_HIDDEN.includes(s) && !hidden.includes(s)) hidden.push(s) }
  return { order, hidden }
}

export const isDefault = (layout: SectionLayout) => layout.hidden.length === DEFAULT_HIDDEN.length && DEFAULT_HIDDEN.every(s => layout.hidden.includes(s)) && layout.order.every((s, i) => s === TODAY_SECTIONS[i])

/** Phone below 700px wide, as the rest of the layout does. */
export function useDevice(): Device {
  const query = '(max-width: 700px)'
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches)
  useEffect(() => {
    const media = window.matchMedia?.(query)
    if (!media) return
    const change = () => setPhone(media.matches)
    media.addEventListener?.('change', change)
    return () => media.removeEventListener?.('change', change)
  }, [])
  return phone ? 'phone' : 'desktop'
}
