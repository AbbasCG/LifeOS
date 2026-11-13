/** Anything with an id and a time range: stored events, expanded occurrences or external events. */
/** `task_closed`: the block of a completed or cancelled task. It stays on the calendar but does not hold the time (the server ignores it too). */
export type Timed = { id: string | number; title?: string; starts_at?: string; ends_at?: string; task_closed?: boolean }
export type Lane<T extends Timed = Timed> = { item: T; lane: number; lanes: number }

/** Assign overlapping events to side-by-side lanes. */
export function layoutLanes<T extends Timed>(items: T[]): Lane<T>[] {
  const sorted = [...items].sort((a, b) => a.starts_at!.localeCompare(b.starts_at!))
  const result: Lane<T>[] = []
  let cluster: Lane<T>[] = [], clusterEnd = 0
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
/** Pixels per hour of the time grid, and the 2px left between a block's bottom edge and the next hour line so back-to-back blocks stay apart. */
export const HOUR_PX = 52
export const BLOCK_GAP = 2

export function snap(minutes: number, step = SNAP_MINUTES) { return Math.round(minutes / step) * step }

/**
 * Minutes from local midnight of `day` to `instant`, read on the wall clock. The grid is a wall-clock grid (its 24 labels are
 * 00:00 to 23:00 on every day), so 10:00 is always 600, also on the 23- and 25-hour days when the clocks change. Below 0 is the
 * day before, above 1440 the day after (a block that crosses midnight).
 */
export function minutesInto(day: Date, instant: Date) {
  const wall = Date.UTC(instant.getFullYear(), instant.getMonth(), instant.getDate(), instant.getHours(), instant.getMinutes(), instant.getSeconds())
  return Math.round((wall - Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())) / 60000)
}

export function atMinutes(day: Date, minutes: number) { const d = new Date(day); d.setHours(0, 0, 0, 0); d.setMinutes(minutes); return d }

/** The block's duration in minutes, in real elapsed time (what the server stores). */
const lengthOf = (start: Date, end: Date) => Math.round((end.getTime() - start.getTime()) / 60000)

/** Height in pixels of a block that lasts `minutes`: proportional to the length, less the 2px gap. 15 minutes is 11px, an hour 50px. */
export function blockHeight(minutes: number) { return Math.max(1, minutes / 60 * HOUR_PX - BLOCK_GAP) }

/**
 * Where a block sits in the column of `day` (wall clock, clipped to that day), plus whether it continues from the day before or
 * into the next one. The height is the length of the visible part: nothing is rounded up to a minimum.
 */
export function blockBox(day: Date, start: Date, end: Date) {
  const from = minutesInto(day, start), to = minutesInto(day, end)
  const top = Math.max(0, Math.min(DAY_MINUTES, from)), bottom = Math.max(0, Math.min(DAY_MINUTES, to))
  return { top: top / 60 * HOUR_PX, height: blockHeight(bottom - top), continues: from < 0, runsOn: to > DAY_MINUTES }
}

/**
 * New start/end when a block is dragged from the column of `origDay` to the column of `day` and shifted by `delta` minutes.
 * A block inside one day stays inside the day it lands on; a block that crosses midnight is not clamped (it would have to
 * change length) and moves by the same wall-clock amount. The length is kept in real time.
 */
export function movePreview(origStart: Date, origEnd: Date, origDay: Date, day: Date, delta: number) {
  const duration = lengthOf(origStart, origEnd), from = minutesInto(origDay, origStart), to = minutesInto(origDay, origEnd)
  const crosses = from < 0 || to > DAY_MINUTES
  const startMinutes = crosses ? from + snap(delta) : Math.max(0, Math.min(DAY_MINUTES - duration, from + snap(delta)))
  const start = atMinutes(day, startMinutes)
  return { start, end: new Date(start.getTime() + duration * 60000) }
}

/** New end when the bottom edge is dragged by `delta` minutes (minimum one snap step, maximum end of day; a block that already runs past midnight may go on). */
export function resizePreview(origStart: Date, origEnd: Date, day: Date, delta: number) {
  const to = minutesInto(day, origEnd), endMinutes = to + snap(delta)
  const min = minutesInto(day, origStart) + SNAP_MINUTES
  return { start: origStart, end: atMinutes(day, Math.max(min, to > DAY_MINUTES ? endMinutes : Math.min(DAY_MINUTES, endMinutes))) }
}

/** First other event overlapping [start, end). Touching edges do not conflict. */
export function findConflict<T extends Timed>(items: T[], id: string | number | undefined, start: Date, end: Date): T | undefined {
  return items.find(item => item.id !== id && !item.task_closed && new Date(item.starts_at!) < end && new Date(item.ends_at!) > start)
}

/** Ids of events that overlap another event. */
export function overlappingIds(items: Timed[]) {
  const ids = new Set<string | number>()
  const sorted = items.filter(item => !item.task_closed).sort((a, b) => a.starts_at!.localeCompare(b.starts_at!))
  sorted.forEach((a, i) => { for (const b of sorted.slice(i + 1)) { if (new Date(b.starts_at!) >= new Date(a.ends_at!)) break; ids.add(a.id); ids.add(b.id) } })
  return ids
}
