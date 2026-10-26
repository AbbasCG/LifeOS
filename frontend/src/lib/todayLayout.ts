import { useEffect, useState } from 'react'

/** The sections at the top of Today (V22), in their default order. "now" can be moved but never hidden. */
export const TODAY_SECTIONS = ['now', 'strip', 'top3', 'progress', 'habits', 'copilot', 'suggestions'] as const
export type TodaySection = typeof TODAY_SECTIONS[number]
export type Device = 'phone' | 'desktop'
export type SectionLayout = { order: TodaySection[]; hidden: TodaySection[] }
export type TodayLayout = Partial<Record<Device, Partial<SectionLayout>>>

/** Sections that take half the width on larger screens; the rest span the full width. */
export const HALF_WIDTH: TodaySection[] = ['top3', 'progress', 'habits']

const known = (s: unknown): s is TodaySection => TODAY_SECTIONS.includes(s as TodaySection)

/** A saved layout made safe: unknown sections dropped, missing ones appended in default order, "now" always shown. */
export function normalizeToday(saved?: Partial<SectionLayout> | null): SectionLayout {
  const order = [...new Set((saved?.order ?? []).filter(known))]
  for (const s of TODAY_SECTIONS) if (!order.includes(s)) order.push(s)
  const hidden = [...new Set((saved?.hidden ?? []).filter(known))].filter(s => s !== 'now')
  return { order, hidden }
}

export const isDefault = (layout: SectionLayout) => layout.hidden.length === 0 && layout.order.every((s, i) => s === TODAY_SECTIONS[i])

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
