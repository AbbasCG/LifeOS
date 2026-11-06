import { useState } from 'react'
import { useNavigate } from 'react-router'
import { startFocus } from './focus'
import { useText } from './i18n'
import { useToast } from './toast'

/**
 * The play button next to a task opens Focus for that task (name and length ready, `/focus?task=ID`) and starts nothing: the countdown begins
 * only when the person presses Start there. Without a task it starts a free focus session in one tap; if a session already runs, it just opens Focus.
 */
export function useStartFocus() {
  const navigate = useNavigate(), toast = useToast(), t = useText()
  const [busy, setBusy] = useState(false)
  async function go(taskId?: number | null) {
    if (taskId) { navigate(`/focus?task=${taskId}`); return }
    setBusy(true)
    try { await startFocus(taskId); navigate('/focus') } catch (e) { toast((e as Error).message || t('Could not start focus.', 'تعذّر بدء التركيز.'), 'error') } finally { setBusy(false) }
  }
  return { go, busy }
}
