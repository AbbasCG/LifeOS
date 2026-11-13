import { Suspense, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, CalendarX, Equal, Flame, Plus, SlidersHorizontal, Sun, Sunrise, WifiOff, Heart } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { useOnline } from '../../lib/pwa'
import { createTaskOrQueue } from '../../lib/offline'
import { api, type NewTask, type RecordItem } from '../../lib/api'
import { readCapture } from '../../lib/capture'
import { accountDay } from '../../lib/accountDay'
import { useLanguage } from '../../contexts/LanguageContext'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { BottomSheet } from '../visual'
import { ErrorMessage } from '../ui/Shared'
import { ChoiceGroup } from '../ui/Choice'
import { DateTimeField } from '../ui/DateTimePicker'
import { openHabitSheet } from '../../lib/quickActions'
import { nextWeekDay, QUICK_ADD, spokenHints, TASKS_CHANGED, type Priority } from '../../lib/quickAdd'
import { quickPlan, type QuickDay, type QuickPlan } from '../../lib/quickPlan'
import { parseConflict, type ScheduleConflict } from '../../lib/scheduleConflict'
import { CALENDAR_CHANGED, sessionWhen } from '../../lib/taskSchedule'
import { choiceOf, dayLabel } from '../../lib/taskWhen'
import { formatTime } from '../../lib/dateTime'
import { useHourCycle } from '../../lib/useHourCycle'

import { lazyPart, whenIdle } from '../../lib/lazyPart'

// Loaded on demand, then fetched in the background once the page is idle so they also work offline.
const VoiceButton = lazyPart(() => import('../../features/assistant/VoiceButton').then(m => m.VoiceButton))
// Only needed when a time turns out to be taken.
const ScheduleConflictDialog = lazyPart(() => import('../ui/ScheduleConflictDialog').then(m => m.ScheduleConflictDialog))
const RecordForm = lazyPart(() => import('../../features/ResourcePage').then(m => m.RecordForm))

/** A booking in plain words: the day ("Tomorrow", "Thu, 12 Nov") and the range on the account's clock (the date of the end too when it passes midnight). */
function planWords(plan: QuickPlan, language: string, t: (en: string, ar: string, nl?: string) => string, cycle: 12 | 24) {
  const day = sessionWhen(plan.starts_at, language, t).dayText, time = (v: string) => formatTime(v, cycle, language)
  const endDay = plan.endDay === plan.day ? '' : sessionWhen(plan.ends_at, language, t).dayText
  return { day, from: time(plan.start), endDay, to: time(plan.endTime) }
}

/**
 * Capture a task with one line: type (or dictate), optionally tap WHEN YOU WANT TO DO IT and how important, press Enter. The day tiles are the
 * same as the task dialog's: they book a calendar session (never a deadline), and nothing is scheduled unless you choose. Natural phrases
 * ("tomorrow at 7pm for one hour") fill the session's day, start and length. One request saves the task and its time; if that time is taken
 * nothing is saved and the user chooses another. "More details" opens the full form with the plan already in it.
 */
export default function QuickAdd() {
  const t = useText(), toast = useToast(), { language } = useLanguage(), [cycle] = useHourCycle(), noteId = useId()
  const [open, setOpen] = useState(false), [text, setText] = useState(''), [when, setWhen] = useState<QuickDay>('none'), [day, setDay] = useState(''), [priority, setPriority] = useState<Priority>('medium')
  const [busy, setBusy] = useState(false), [voice, setVoice] = useState(false), [error, setError] = useState(''), [draft, setDraft] = useState<Partial<RecordItem> | null>(null)
  const [conflict, setConflict] = useState<ScheduleConflict | null>(null), saving = useRef(false)
  const online = useOnline(), [params, setParams] = useSearchParams()
  useEffect(() => whenIdle(() => { VoiceButton.preload(); RecordForm.preload(); ScheduleConflictDialog.preload() }), [])
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
  // What the typed or dictated phrase said, and the booking the tiles and the phrase make together, shown before saving so nothing is a surprise.
  const read = readCapture(text), plan = quickPlan(read, when, day)
  const words = plan && planWords(plan, language, t, cycle)
  const understood = words
    ? <><bdi>{words.day}</bdi>{' '}<bdi dir="ltr">{words.from}–{words.endDay && <>{words.endDay} </>}{words.to}</bdi></>
    : read.found.duration ? t(`${read.task.estimated_minutes} min`, `${read.task.estimated_minutes} دقيقة`, `${read.task.estimated_minutes} min`) : null
  /** The task as it is saved: never a deadline; `starts_at` only when a day is chosen (or the phrase said when). */
  function task(booked: QuickPlan | null): NewTask {
    return { title: read.task.title, estimated_minutes: read.task.estimated_minutes, status: 'todo', priority, ...(booked ? { schedule: { starts_at: booked.starts_at } } : {}) }
  }
  function close() {
    setOpen(false)
    if (params.get('add')) setParams(p => { p.delete('add'); return p }, { replace: true })
    setText(''); setWhen('none'); setDay(''); setPriority('medium'); setVoice(false); setConflict(null) }
  /** The full form, with the title, the priority and the planned day, start and length already filled in (the deadline stays off). */
  function openDetails(startsAt?: string) {
    const booked = quickPlan(read, when, day, new Date(), startsAt)
    setDraft({ title: read.task.title, estimated_minutes: read.task.estimated_minutes, status: 'todo', priority, ...(booked ? { planned: { starts_at: booked.starts_at } } : {}) }); close()
  }
  /** `startsAt`: the start the user accepted from a conflict's suggestion. Sent once: a second tap while this runs sends nothing. */
  async function save(e?: FormEvent, startsAt?: string) {
    e?.preventDefault()
    if (!text.trim() || saving.current) return
    const booked = quickPlan(read, when, day, new Date(), startsAt)
    if (booked && Date.parse(booked.ends_at) <= Date.now()) { setError(t('Choose a time that has not passed.', 'اختر وقتًا لم يمضِ.', 'Kies een tijd die nog niet voorbij is.')); return }
    saving.current = true; setBusy(true); setError('')
    try {
      const result = await createTaskOrQueue(task(booked))
      // Kept on this device: lists are not reloaded, so what is on screen stays while offline.
      if (result === 'created') { window.dispatchEvent(new Event(TASKS_CHANGED)); if (booked) window.dispatchEvent(new Event(CALENDAR_CHANGED)) }
      const w = booked && planWords(booked, language, t, cycle), when_ = w && `${w.day} ${w.from}–${w.endDay ? `${w.endDay} ` : ''}${w.to}`
      toast(result === 'queued' ? t('Saved on this device. Send it from “Waiting to sync” when you’re online.', 'حُفظت على هذا الجهاز. أرسلها من «بانتظار المزامنة» عند الاتصال.', 'Op dit apparaat bewaard. Verstuur het vanuit “Wacht op synchronisatie” als je online bent.')
        : when_ ? t(`Added and scheduled: ${when_}`, `أُضيفت وجُدولت ${when_}`, `Toegevoegd en ingepland: ${when_}`) : t('Task added.', 'أُضيفت المهمة.', 'Taak toegevoegd.'))
      close()
    } catch (err) {
      // A taken time: nothing was saved, the sheet stays with its text, and the dialog says what is in the way.
      const taken = parseConflict(err)
      if (taken) setConflict(taken); else setError((err as Error).message)
    } finally { saving.current = false; setBusy(false) }
  }
  const icon = (Icon: typeof Sun) => <Icon size={20} aria-hidden="true" />
  const heading = t('When do you want to do it?', 'متى تريد تنفيذها؟', 'Wanneer wil je het doen?')
  const choice = when === 'custom' ? choiceOf(day) === 'custom' ? 'custom' : choiceOf(day) : when
  const tile = (value: QuickDay, label: string, Icon: typeof Sun, on: () => void) => <button key={value} type="button" role="radio" aria-checked={choice === value} className="choice" onClick={on}><span className="choice-icon">{icon(Icon)}</span><span className="choice-label">{label}</span></button>
  const priorities: { value: Priority; label: string; icon: ReactNode; tone: string }[] = [{ value: 'urgent', label: t('Urgent', 'عاجل'), icon: icon(Flame), tone: 'urgent' }, { value: 'high', label: t('High', 'عالية'), icon: icon(ArrowUp), tone: 'high' }, { value: 'medium', label: t('Normal', 'عادية'), icon: icon(Equal), tone: 'medium' }, { value: 'low', label: t('Low', 'منخفضة'), icon: icon(ArrowDown), tone: 'low' }]
  return <>
    {shown && <BottomSheet title={t('Quick add', 'إضافة سريعة')} onClose={close} dirty={() => text.trim() !== ''} footer={
      <button type="submit" form="quick-add-form" className="primary qa-add" aria-disabled={busy || undefined} disabled={!text.trim()}><Plus size={20} aria-hidden="true" />{t('Add task', 'إضافة المهمة')}</button>}>
      <form id="quick-add-form" className="quick-add" onSubmit={e => void save(e)}>
        <div className="quick-add-input">
          <input data-autofocus className="qa-title" value={text} maxLength={200} onChange={e => setText(e.target.value)} aria-label={t('Task', 'المهمة')} aria-describedby={understood ? noteId : undefined} placeholder={t('What needs doing?', 'ما الذي يجب إنجازه؟')} enterKeyHint="done" autoComplete="off" autoCapitalize="sentences" />
          {voiceAllowed && <Suspense fallback={null}><VoiceButton autoStart={voice} onText={said => { setText(v => `${v.trimEnd()}${v.trim() ? ' ' : ''}${said}`.slice(0, 200)); const hints = spokenHints(said); if (hints.when === 'nextweek') { setDay(nextWeekDay()); setWhen('custom') } else if (hints.when === 'today' || hints.when === 'tomorrow') setWhen(hints.when); if (hints.priority) setPriority(hints.priority) }} /></Suspense>}
        </div>
        {understood && <p id={noteId} className="muted small qa-understood">{t('Understood: ', 'فُهم: ', 'Begrepen: ')}{understood}</p>}
        <div className="field-block">
          <span className="field-title" id={`${noteId}-when`}>{heading}</span>
          <div className="qa-whens rf-whens" role="radiogroup" aria-labelledby={`${noteId}-when`}>
            {tile('today', t('Today', 'اليوم', 'Vandaag'), Sun, () => setWhen('today'))}
            {tile('tomorrow', t('Tomorrow', 'غدًا', 'Morgen'), Sunrise, () => setWhen('tomorrow'))}
            <span className={`qa-pick${choice === 'custom' ? ' is-set' : ''}`}><DateTimeField kind="date" value={choice === 'custom' ? day : ''} min={accountDay()} onChange={v => { setDay(v); setWhen(v ? 'custom' : 'none') }} label={t('Pick a date', 'تاريخ آخر', 'Andere datum')} placeholder={t('Pick a date', 'تاريخ آخر', 'Andere datum')} shown={choice === 'custom' ? dayLabel(day, language) : undefined} radioChecked={choice === 'custom'} /></span>
            {tile('none', t('Not scheduled', 'بدون جدولة', 'Niet ingepland'), CalendarX, () => setWhen('none'))}
          </div>
        </div>
        <ChoiceGroup label={t('Priority', 'الأولوية')} variant="tiles" columns={4} value={priority} onChange={setPriority} options={priorities} />
        <div className="qa-more">
          <button type="button" className="quiet quick-habit" onClick={() => { close(); openHabitSheet() }}><Heart size={18} aria-hidden="true" />{t('Log a habit', 'سجّل عادة')}</button>
          <button type="button" className="quiet" disabled={!text.trim()} onClick={() => openDetails()}><SlidersHorizontal size={18} aria-hidden="true" />{t('More details', 'تفاصيل أكثر')}</button>
        </div>
        {!online && <p className="offline-note" role="status"><WifiOff size={14} aria-hidden="true" />{t('You’re offline. The task is kept on this device until you send it.', 'أنت غير متصل. تُحفظ المهمة على هذا الجهاز حتى ترسلها.')}</p>}
        <ErrorMessage error={error} />
      </form>
      {conflict && <Suspense fallback={null}><ScheduleConflictDialog key={conflict.requested.starts_at} conflict={conflict} onClose={() => setConflict(null)} onChoose={() => openDetails(conflict.requested.starts_at)}
        onUseSuggestion={slot => { setConflict(null); void save(undefined, slot.starts_at) }} /></Suspense>}
    </BottomSheet>}
    {draft && <Suspense fallback={null}><RecordForm resource="tasks" item={draft} onSave={() => window.dispatchEvent(new Event(TASKS_CHANGED))} onClose={() => setDraft(null)} /></Suspense>}
  </>
}
