import { Suspense, useEffect, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, CalendarDays, CalendarX, Flame, Plus, SlidersHorizontal, Sun, Sunrise, WifiOff, Heart } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { useOnline } from '../../lib/pwa'
import { createTaskOrQueue } from '../../lib/offline'
import type { RecordItem } from '../../lib/api'
import { parseCapture } from '../../lib/capture'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { BottomSheet } from '../visual'
import { ErrorMessage } from '../ui/Shared'
import { openHabitSheet } from '../../lib/quickActions'
import { dueFor, QUICK_ADD, TASKS_CHANGED, type Priority, type When } from '../../lib/quickAdd'

import { lazyPart, whenIdle } from '../../lib/lazyPart'

// Loaded on demand, then fetched in the background once the page is idle so they also work offline.
const VoiceButton = lazyPart(() => import('../../features/assistant/VoiceButton').then(m => m.VoiceButton))
const RecordForm = lazyPart(() => import('../../features/ResourcePage').then(m => m.RecordForm))

/**
 * Capture a task with one line: type (or dictate), optionally tap when and how important, press Enter. Natural phrases
 * ("tomorrow at 7pm for one hour") still fill the time and length. "More details" opens the full form.
 */
export default function QuickAdd() {
  const t = useText(), toast = useToast()
  const [open, setOpen] = useState(false), [text, setText] = useState(''), [when, setWhen] = useState<When>('today'), [priority, setPriority] = useState<Priority>('medium')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [draft, setDraft] = useState<Partial<RecordItem> | null>(null)
  const online = useOnline(), [params, setParams] = useSearchParams()
  useEffect(() => whenIdle(() => { VoiceButton.preload(); RecordForm.preload() }), [])
  useEffect(() => {
    const show = () => { setOpen(true); setError('') }
    window.addEventListener(QUICK_ADD, show)
    return () => window.removeEventListener(QUICK_ADD, show)
  }, [])
  // The installed app's "Add task" shortcut opens /?add=task; closing the sheet clears it.
  const shown = open || params.get('add') === 'task'
  function task(): Partial<RecordItem> {
    const parsed = parseCapture(text)
    return { ...parsed, status: 'todo', priority, due_at: parsed.due_at ?? dueFor(when) }
  }
  function close() {
    setOpen(false)
    if (params.get('add')) setParams(p => { p.delete('add'); return p }, { replace: true })
    setText(''); setWhen('today'); setPriority('medium') }
  async function save(e?: FormEvent) {
    e?.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true); setError('')
    try {
      const result = await createTaskOrQueue(task())
      // Kept on this device: lists are not reloaded, so what is on screen stays while offline.
      if (result === 'created') window.dispatchEvent(new Event(TASKS_CHANGED))
      toast(result === 'queued' ? t('Saved on this device. Send it from “Waiting to sync” when you’re online.', 'حُفظت على هذا الجهاز. أرسلها من «بانتظار المزامنة» عند الاتصال.') : t('Task added.', 'أُضيفت المهمة.'))
      close()
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  const whens: [When, string, typeof Sun][] = [['today', t('Today', 'اليوم'), Sun], ['tomorrow', t('Tomorrow', 'غداً'), Sunrise], ['week', t('This week', 'هذا الأسبوع'), CalendarDays], ['none', t('No date', 'بلا موعد'), CalendarX]]
  const priorities: [Priority, string, typeof Flame][] = [['urgent', t('Urgent', 'عاجل'), Flame], ['high', t('High', 'عالية'), ArrowUp], ['medium', t('Normal', 'عادية'), Plus], ['low', t('Low', 'منخفضة'), ArrowDown]]
  return <>
    {shown && <BottomSheet title={t('Quick add', 'إضافة سريعة')} onClose={close} footer={<>
      <button type="button" className="quiet quick-habit" onClick={() => { close(); openHabitSheet() }}><Heart size={16} />{t('Log a habit', 'سجّل عادة')}</button>
      <button type="button" className="quiet" disabled={!text.trim()} onClick={() => { setDraft(task()); close() }}><SlidersHorizontal size={16} />{t('More details', 'تفاصيل أكثر')}</button>
      <button type="submit" form="quick-add-form" className="primary" disabled={!text.trim() || busy}><Plus size={17} />{t('Add task', 'إضافة المهمة')}</button>
    </>}>
      <form id="quick-add-form" className="quick-add" onSubmit={e => void save(e)}>
        <div className="quick-add-input">
          <input data-autofocus value={text} maxLength={200} onChange={e => setText(e.target.value)} aria-label={t('Task', 'المهمة')} placeholder={t('What needs doing?', 'ما الذي يجب إنجازه؟')} />
          <Suspense fallback={null}><VoiceButton onText={said => setText(v => `${v.trimEnd()}${v.trim() ? ' ' : ''}${said}`.slice(0, 200))} /></Suspense>
        </div>
        <div className="chip-row" role="radiogroup" aria-label={t('When', 'متى')}>{whens.map(([value, label, Icon]) => <button key={value} type="button" role="radio" aria-checked={when === value} className="filter-chip" onClick={() => setWhen(value)}><Icon size={14} aria-hidden="true" />{label}</button>)}</div>
        <div className="chip-row" role="radiogroup" aria-label={t('Priority', 'الأولوية')}>{priorities.map(([value, label, Icon]) => <button key={value} type="button" role="radio" aria-checked={priority === value} className={`filter-chip prio-chip-${value}`} onClick={() => setPriority(value)}><Icon size={14} aria-hidden="true" />{label}</button>)}</div>
        {!online && <p className="offline-note" role="status"><WifiOff size={14} aria-hidden="true" />{t('You’re offline. The task is kept on this device until you send it.', 'أنت غير متصل. تُحفظ المهمة على هذا الجهاز حتى ترسلها.')}</p>}
        <ErrorMessage error={error} />
      </form>
    </BottomSheet>}
    {draft && <Suspense fallback={null}><RecordForm resource="tasks" item={draft} onSave={() => window.dispatchEvent(new Event(TASKS_CHANGED))} onClose={() => setDraft(null)} /></Suspense>}
  </>
}
