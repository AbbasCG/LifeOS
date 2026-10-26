import { useState } from 'react'
import { useNavigate } from 'react-router'
import { startFocus } from './focus'
import { useText } from './i18n'
import { useToast } from './toast'

/** Start focus in one tap; if a session already runs, just open it. */
export function useStartFocus() {
  const navigate = useNavigate(), toast = useToast(), t = useText()
  const [busy, setBusy] = useState(false)
  async function go(taskId?: number | null) {
    setBusy(true)
    try { await startFocus(taskId); navigate('/focus') } catch (e) { toast((e as Error).message || t('Could not start focus.', 'تعذّر بدء التركيز.'), 'error') } finally { setBusy(false) }
  }
  return { go, busy }
}
