import type { RecordItem } from './api'

export type Lane = { item: RecordItem; lane: number; lanes: number }

/** Assign overlapping events to side-by-side lanes. */
export function layoutLanes(items: RecordItem[]): Lane[] {
  const sorted = [...items].sort((a, b) => a.starts_at!.localeCompare(b.starts_at!))
  const result: Lane[] = []
  let cluster: Lane[] = [], clusterEnd = 0
  const flush = () => { const lanes = Math.max(1, ...cluster.map(c => c.lane + 1)); cluster.forEach(c => { c.lanes = lanes }); result.push(...cluster); cluster = [] }
  for (const item of sorted) {
    const start = new Date(item.starts_at!).getTime(), end = new Date(item.ends_at!).getTime()
    if (cluster.length && start >= clusterEnd) flush()
    const used = cluster.filter(c => new Date(c.item.ends_at!).getTime() > start).map(c => c.lane)
    let lane = 0
    while (used.includes(lane)) lane++
    cluster.push({ item, lane, lanes: 1 })
    clusterEnd = Math.max(clusterEnd, end)
  }
  if (cluster.length) flush()
  return result
}

export const SNAP_MINUTES = 15
export const DAY_MINUTES = 24 * 60

export function snap(minutes: number, step = SNAP_MINUTES) { return Math.round(minutes / step) * step }

/** Minutes since local midnight of `day`. */
export function minutesInto(day: Date, instant: Date) { return Math.round((instant.getTime() - new Date(day).setHours(0, 0, 0, 0)) / 60000) }

export function atMinutes(day: Date, minutes: number) { const d = new Date(day); d.setHours(0, 0, 0, 0); d.setMinutes(minutes); return d }

/** New start/end when a block is dragged to `day` and shifted by `delta` minutes; it stays inside that day. */
export function movePreview(origStart: Date, origEnd: Date, origDay: Date, day: Date, delta: number) {
  const duration = Math.round((origEnd.getTime() - origStart.getTime()) / 60000)
  const startMinutes = Math.max(0, Math.min(DAY_MINUTES - duration, minutesInto(origDay, origStart) + snap(delta)))
  const start = atMinutes(day, startMinutes)
  return { start, end: new Date(start.getTime() + duration * 60000) }
}

/** New end when the bottom edge is dragged by `delta` minutes (minimum one snap step, maximum end of day). */
export function resizePreview(origStart: Date, origEnd: Date, day: Date, delta: number) {
  const endMinutes = minutesInto(day, origEnd) + snap(delta)
  const min = minutesInto(day, origStart) + SNAP_MINUTES
  return { start: origStart, end: atMinutes(day, Math.max(min, Math.min(DAY_MINUTES, endMinutes))) }
}

/** First other event overlapping [start, end). Touching edges do not conflict. */
export function findConflict(items: RecordItem[], id: number | undefined, start: Date, end: Date) {
  return items.find(item => item.id !== id && new Date(item.starts_at!) < end && new Date(item.ends_at!) > start)
}

/** Ids of events that overlap another event. */
export function overlappingIds(items: RecordItem[]) {
  const ids = new Set<number>()
  const sorted = [...items].sort((a, b) => a.starts_at!.localeCompare(b.starts_at!))
  sorted.forEach((a, i) => { for (const b of sorted.slice(i + 1)) { if (new Date(b.starts_at!) >= new Date(a.ends_at!)) break; ids.add(a.id); ids.add(b.id) } })
  return ids
}
