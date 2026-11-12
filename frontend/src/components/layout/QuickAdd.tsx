import { Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, CalendarDays, CalendarX, Equal, Flame, Plus, SlidersHorizontal, Sun, Sunrise, WifiOff, Heart } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { useOnline } from '../../lib/pwa'
import { createTaskOrQueue } from '../../lib/offline'
import { api, type RecordItem } from '../../lib/api'
import { readCapture } from '../../lib/capture'
import { accountZone } from '../../lib/accountDay'
import { useLanguage } from '../../contexts/LanguageContext'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { BottomSheet } from '../visual'
import { ErrorMessage } from '../ui/Shared'
import { ChoiceGroup } from '../ui/Choice'
import { DateTimeField } from '../ui/DateTimePicker'
import { openHabitSheet } from '../../lib/quickActions'
import { dueFor, dueForDay, nextWeekDay, QUICK_ADD, spokenHints, TASKS_CHANGED, type Priority, type QuickWhen } from '../../lib/quickAdd'

import { lazyPart, whenIdle } from '../../lib/lazyPart'
import { formatDayTime } from '../../lib/clock'

// Loaded on demand, then fetched in the background once the page is idle so they also work offline.
const VoiceButton = lazyPart(() => import('../../features/assistant/VoiceButton').then(m => m.VoiceButton))
const RecordForm = lazyPart(() => import('../../features/ResourcePage').then(m => m.RecordForm))

/**
 * Capture a task with one line: type (or dictate), optionally tap when and how important, press Enter. Natural phrases
 * ("tomorrow at 7pm for one hour") still fill the time and length. "More details" opens the full form.
 */
export default function QuickAdd() {
  const t = useText(), toast = useToast(), { language } = useLanguage()
  const [open, setOpen] = useState(false), [text, setText] = useState(''), [when, setWhen] = useState<QuickWhen>('today'), [day, setDay] = useState(''), [priority, setPriority] = useState<Priority>('medium')
  const [busy, setBusy] = useState(false), [voice, setVoice] = useState(false), [error, setError] = useState(''), [draft, setDraft] = useState<Partial<RecordItem> | null>(null)
  const online = useOnline(), [params, setParams] = useSearchParams()
  useEffect(() => whenIdle(() => { VoiceButton.preload(); RecordForm.preload() }), [])
  useEffect(() => {
    const show = (e: Event) => { setOpen(true); setError(''); setVoice((e as CustomEvent<{ voice?: boolean } | undefined>).detail?.voice === true) }
    window.addEventListener(QUICK_ADD, show)
    return () => window.removeEventListener(QUICK_ADD, show)
  }, [])
  // The installed app's "Add task" shortcut opens /?add=task; closing the sheet clears it.
  const shown = open || params.get('add') === 'task'
  // The account can switch dictation off (AI Control Center); checked when the sheet opens, and allowed until known.
  const [voiceAllowed, setVoiceAllowed] = useState(true)
  useEffect(() => {
    if (!shown) return
    let live = true
    api<{ voice_allowed?: boolean }>('/api/assistant/status').then(s => { if (live) setVoiceAllowed(s.voice_allowed !== false) }).catch(() => {})
    return () => { live = false }
  }, [shown])
  // What the typed or dictated phrase said about the time and length, shown before saving so nothing is a surprise.
  const read = readCapture(text)
  const understood = [
    read.found.due && read.task.due_at ? formatDayTime(read.task.due_at, { language, timeZone: accountZone() }) : '',
    read.found.duration ? t(`${read.task.estimated_minutes} min`, `${read.task.estimated_minutes} دقيقة`) : '',
  ].filter(Boolean).join(' · ')
  function task(): Partial<RecordItem> {
    const parsed = read.task
    return { ...parsed, status: 'todo', priority, due_at: parsed.due_at ?? (when === 'custom' ? dueForDay(day) : dueFor(when)) }
  }
  function close() {
    setOpen(false)
    if (params.get('add')) setParams(p => { p.delete('add'); return p }, { replace: true })
    setText(''); setWhen('today'); setDay(''); setPriority('medium'); setVoice(false) }
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
  const icon = (Icon: typeof Sun) => <Icon size={20} aria-hidden="true" />
  const whens: { value: QuickWhen; label: string; icon: ReactNode }[] = [{ value: 'today', label: t('Today', 'اليوم'), icon: icon(Sun) }, { value: 'tomorrow', label: t('Tomorrow', 'غداً'), icon: icon(Sunrise) }, { value: 'week', label: t('This week', 'هذا الأسبوع'), icon: icon(CalendarDays) }, { value: 'none', label: t('No date', 'بلا موعد'), icon: icon(CalendarX) }]
  const priorities: { value: Priority; label: string; icon: ReactNode; tone: string }[] = [{ value: 'urgent', label: t('Urgent', 'عاجل'), icon: icon(Flame), tone: 'urgent' }, { value: 'high', label: t('High', 'عالية'), icon: icon(ArrowUp), tone: 'high' }, { value: 'medium', label: t('Normal', 'عادية'), icon: icon(Equal), tone: 'medium' }, { value: 'low', label: t('Low', 'منخفضة'), icon: icon(ArrowDown), tone: 'low' }]
  return <>
    {shown && <BottomSheet title={t('Quick add', 'إضافة سريعة')} onClose={close} dirty={() => text.trim() !== ''} footer={
      <button type="submit" form="quick-add-form" className="primary qa-add" disabled={!text.trim() || busy}><Plus size={20} aria-hidden="true" />{t('Add task', 'إضافة المهمة')}</button>}>
      <form id="quick-add-form" className="quick-add" onSubmit={e => void save(e)}>
        <div className="quick-add-input">
          <input data-autofocus className="qa-title" value={text} maxLength={200} onChange={e => setText(e.target.value)} aria-label={t('Task', 'المهمة')} placeholder={t('What needs doing?', 'ما الذي يجب إنجازه؟')} enterKeyHint="done" autoComplete="off" autoCapitalize="sentences" />
          {voiceAllowed && <Suspense fallback={null}><VoiceButton autoStart={voice} onText={said => { setText(v => `${v.trimEnd()}${v.trim() ? ' ' : ''}${said}`.slice(0, 200)); const hints = spokenHints(said); if (hints.when === 'nextweek') { setDay(nextWeekDay()); setWhen('custom') } else if (hints.when) setWhen(hints.when); if (hints.priority) setPriority(hints.priority) }} /></Suspense>}
        </div>
        {understood && <p className="muted small qa-understood" role="status">{t('Understood: ', 'فُهم: ')}{understood}</p>}
        <div className="field-block">
          <div className="qa-whens" role="radiogroup" aria-label={t('When', 'متى')}>
            {whens.slice(0, 3).map(o => <button key={o.value} type="button" role="radio" aria-checked={when === o.value} className="choice" onClick={() => setWhen(o.value)}><span className="choice-icon">{o.icon}</span><span className="choice-label">{o.label}</span></button>)}
            <span className={`qa-pick${when === 'custom' ? ' is-set' : ''}`}><DateTimeField kind="date" value={day} onChange={v => { setDay(v); setWhen(v ? 'custom' : 'today') }} label={t('Pick a date', 'اختيار تاريخ')} radioChecked={when === 'custom'} /></span>
            {whens.slice(3).map(o => <button key={o.value} type="button" role="radio" aria-checked={when === o.value} className="choice" onClick={() => setWhen(o.value)}><span className="choice-icon">{o.icon}</span><span className="choice-label">{o.label}</span></button>)}
          </div>
        </div>
        <ChoiceGroup label={t('Priority', 'الأولوية')} variant="tiles" columns={4} value={priority} onChange={setPriority} options={priorities} />
        <div className="qa-more">
          <button type="button" className="quiet quick-habit" onClick={() => { close(); openHabitSheet() }}><Heart size={18} aria-hidden="true" />{t('Log a habit', 'سجّل عادة')}</button>
          <button type="button" className="quiet" disabled={!text.trim()} onClick={() => { setDraft(task()); close() }}><SlidersHorizontal size={18} aria-hidden="true" />{t('More details', 'تفاصيل أكثر')}</button>
        </div>
        {!online && <p className="offline-note" role="status"><WifiOff size={14} aria-hidden="true" />{t('You’re offline. The task is kept on this device until you send it.', 'أنت غير متصل. تُحفظ المهمة على هذا الجهاز حتى ترسلها.')}</p>}
        <ErrorMessage error={error} />
      </form>
    </BottomSheet>}
    {draft && <Suspense fallback={null}><RecordForm resource="tasks" item={draft} onSave={() => window.dispatchEvent(new Event(TASKS_CHANGED))} onClose={() => setDraft(null)} /></Suspense>}
  </>
}
