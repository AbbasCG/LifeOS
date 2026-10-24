export type TimelineItem = {
  id: string; kind: 'event' | 'task' | 'external_task' | 'focus' | 'goal' | 'habit'; source: string; source_label: string
  account_id: number | null; account: string | null; title: string; starts_at: string; ends_at: string | null; all_day: boolean
  area: 'work' | 'study' | 'personal' | null; read_only: boolean; status: string; recurring: boolean; moved_from: string | null; link: string; conflict: boolean
  meta: { priority?: string; estimated_minutes?: number; minutes?: number; percent?: number; external_id?: number; list?: string; task_id?: number; timezone?: string; recurrence?: string }
}
export type TimelineConflict = {
  type: 'overlap' | 'busy_task' | 'duplicate' | 'timezone' | 'moved' | 'cancelled' | 'deadline'; severity: 'high' | 'info'; at: string; minutes: number; items: string[]; titles: string[]
  sources?: string[]; accounts?: string[]; organiser_time?: string; organiser_zone?: string; your_time?: string; from?: string; to?: string; need?: number; free?: number; meetings?: number
}
type Facet = { key: string; count: number }
export type TimelineData = {
  range: { from: string; to: string; timezone: string; day_start: string }
  items: TimelineItem[]
  conflicts: TimelineConflict[]
  facets: { sources: (Facet & { label: string })[]; accounts: { id: number; provider: string; label: string; source_label: string; status: string; count: number }[]; areas: Facet[]; kinds: Facet[] }
}

/** Add days to a YYYY-MM-DD date (calendar arithmetic at noon, so DST never shifts the date). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
