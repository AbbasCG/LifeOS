import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type CalendarOccurrence } from './api'

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
      .then(value => { if (active && current.current === requestKey) setState({ key: requestKey, items: value.data, error: '' }) })
      .catch(e => { if (active) setState(s => ({ ...s, key: requestKey, error: (e as Error).message })) })
    return () => { active = false }
  }, [key, requestKey])
  const reload = useCallback(() => setRevision(v => v + 1), [])
  const setItems = useCallback((items: CalendarOccurrence[]) => setState(s => ({ ...s, items })), [])
  const setError = useCallback((error: string) => setState(s => ({ ...s, error })), [])
  return { items: state.items, setItems, error: state.error, setError, loading: !state.key.startsWith(key), reload }
}
