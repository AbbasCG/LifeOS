export const WIDGETS = ['today', 'suggestions', 'stats', 'progress', 'next_moves', 'agenda', 'focus_time', 'checkin', 'deadlines', 'habits', 'goals', 'actions', 'focus', 'weekly', 'review'] as const
export type WidgetId = typeof WIDGETS[number]
export type DashboardLayout = { order: WidgetId[]; hidden: WidgetId[] }
export const FULL_WIDTH: WidgetId[] = ['today', 'suggestions', 'stats']

/** Merge a saved layout with the known widgets: unknown ids are dropped, new widgets are appended. */
export function normalizeLayout(saved?: Partial<DashboardLayout> | null): DashboardLayout {
  const known = (ids: unknown) => (Array.isArray(ids) ? ids : []).filter((id): id is WidgetId => (WIDGETS as readonly string[]).includes(id as string))
  const order = [...new Set(known(saved?.order))]
  return { order: [...order, ...WIDGETS.filter(id => !order.includes(id))], hidden: [...new Set(known(saved?.hidden))] }
}

export function moveItem<T>(list: T[], from: number, to: number) {
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item)
  return next
}
