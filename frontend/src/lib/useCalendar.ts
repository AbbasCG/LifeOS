import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type CalendarOccurrence } from './api'
import { CALENDAR_CHANGED } from './taskSchedule'

/**
 * The same occurrence listed twice (one `id` repeated, e.g. a response that was merged from two reads) is one session, not two.
 * Identity only: two stored events with the same title and time have different ids and both stay.
 */
export function uniqueById(items: CalendarOccurrence[]): CalendarOccurrence[] {
  const seen = new Set<string>()
  return items.filter(i => { const key = String(i.id); if (seen.has(key)) return false; seen.add(key); return true })
}

type State = { key: string; items: CalendarOccurrence[]; error: string }

/** Expanded calendar occurrences for [from, to), with optimistic local edits and reload. */
export function useCalendar(from: Date, to: Date) {
  const key = `/api/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<State>({ key: '', items: [], error: '' })
  const requestKey = `${key}#${revision}`
  const current = useRef(requestKey)
  useEffect(() => {
    current.current = requestKey
    let active = true
    api<{ data: CalendarOccurrence[] }>(key)
      .then(value => { if (active && current.current === requestKey) setState({ key: requestKey, items: uniqueById(value.data), error: '' }) })
      .catch(e => { if (active) setState(s => ({ ...s, key: requestKey, error: (e as Error).message })) })
    return () => { active = false }
  }, [key, requestKey])
  const reload = useCallback(() => setRevision(v => v + 1), [])
  // A session booked, moved or removed anywhere in the app (the task list, a dialog) makes every open calendar read the server again.
  useEffect(() => { window.addEventListener(CALENDAR_CHANGED, reload); return () => window.removeEventListener(CALENDAR_CHANGED, reload) }, [reload])
  // The optimistic edit of a block and its rollback change one item and must not undo a reload that landed in between: they pass an updater.
  const setItems = useCallback((items: CalendarOccurrence[] | ((current: CalendarOccurrence[]) => CalendarOccurrence[])) => setState(s => ({ ...s, items: typeof items === 'function' ? items(s.items) : items })), [])
  // A second tab or device may have moved or removed blocks while this one was hidden: read the server again when it comes back (an event, not polling).
  useEffect(() => {
    const back = () => { if (document.visibilityState === 'visible') reload() }
    document.addEventListener('visibilitychange', back)
    return () => document.removeEventListener('visibilitychange', back)
  }, [reload])
  const setError = useCallback((error: string) => setState(s => ({ ...s, error })), [])
  return { items: state.items, setItems, error: state.error, setError, loading: !state.key.startsWith(key), reload }
}
