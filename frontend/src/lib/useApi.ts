import { useCallback, useEffect, useState } from 'react'
import { api } from './api'

/** Fetch a JSON endpoint, exposing data, error, loading and a reload function. */
export function useApi<T>(path: string | null) {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: string }>({ path: null, data: null, error: '' })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!path) return
    let active = true
    api<T>(path)
      .then(data => { if (active) setState({ path, data, error: '' }) })
      .catch(e => { if (active) setState(s => ({ path, data: s.data, error: (e as Error).message })) })
    return () => { active = false }
  }, [path, revision])
  const reload = useCallback(() => setRevision(v => v + 1), [])
  return { data: state.data, error: state.error, loading: state.path !== path, reload }
}
