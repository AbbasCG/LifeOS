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
