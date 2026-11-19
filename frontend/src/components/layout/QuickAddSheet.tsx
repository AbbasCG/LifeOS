import { Suspense, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, CalendarX, Equal, Flame, Plus, SlidersHorizontal, Sun, Sunrise, WifiOff, Heart } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { useOnline } from '../../lib/pwa'
import { createTaskOrQueue } from '../../lib/offline'
import { api, ApiError, type NewTask, type RecordItem } from '../../lib/api'
import { readCapture } from '../../lib/capture'
import { accountDay } from '../../lib/accountDay'
import { useLanguage } from '../../contexts/LanguageContext'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { BottomSheet } from '../visual'
import PrayerOverlapNote from '../PrayerOverlapNote'
import { ChoiceGroup } from '../ui/Choice'
import { DateTimeField } from '../ui/DateTimePicker'
import { openHabitSheet } from '../../lib/quickActions'
import { nextWeekDay, spokenHints, TASKS_CHANGED, type Priority } from '../../lib/quickAdd'
import { quickPlan, type QuickDay, type QuickPlan } from '../../lib/quickPlan'
import { parseConflict, type ScheduleConflict } from '../../lib/scheduleConflict'
import { CALENDAR_CHANGED, newIdempotencyKey, sessionWhen } from '../../lib/taskSchedule'
import { choiceOf, dayLabel, defaultWhen } from '../../lib/taskWhen'


import { VoiceButton, ScheduleConflictDialog, RecordForm } from './quickAddParts'

/**
 * A booking in plain words: the day ("Tomorrow", "Thu, 12 Nov") and the range on the account's clock, ALWAYS 24-hour here (the same clock the
 * conflict dialog uses), with the date of the end too when it passes midnight.
 */
function planWords(plan: QuickPlan, language: string, t: (en: string, ar: string, nl?: string) => string) {
  const day = sessionWhen(plan.starts_at, language, t).dayText
  const endDay = plan.endDay === plan.day ? '' : sessionWhen(plan.ends_at, language, t).dayText
  return { day, from: plan.start, endDay, to: plan.endTime }
}
/** Times keep their own direction inside an Arabic sentence (the plain-text twin of <bdi dir="ltr">, for toasts). */
const isolate = (language: string, text: string) => language === 'ar' ? `\u2066${text}\u2069` : text

/**
 * Capture a task with one line: type (or dictate), optionally tap WHEN YOU WANT TO DO IT and how important, press Enter. The day tiles are the
 * same as the task dialog's: they book a calendar session (never a deadline), and nothing is scheduled unless you choose. Natural phrases
 * ("tomorrow at 7pm for one hour") fill the session's day, start and length. One request saves the task and its time; if that time is taken
 * nothing is saved and the user chooses another. "More details" opens the full form with the plan already in it.
 * While the phrase says the day ("tomorrow at 10"), it wins and the tiles show it: that tile is selected, marked «from your text», and
 * another tile only says how to choose differently. The words that were understood are left out of the saved title ("Call the bank"),
 * unless «Keep my exact text» is ticked (until the sheet closes).
 */
export default function QuickAddSheet({ open, voice, setOpen, setVoice }: { open: boolean; voice: boolean; setOpen: (open: boolean) => void; setVoice: (voice: boolean) => void }) {
  const t = useText(), toast = useToast(), { language } = useLanguage(), noteId = useId(), errorId = useId()
  const [text, setText] = useState(''), [when, setWhen] = useState<QuickDay>('none'), [day, setDay] = useState(''), [priority, setPriority] = useState<Priority>('medium')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [draft, setDraft] = useState<Partial<RecordItem> | null>(null)
  const [conflict, setConflict] = useState<ScheduleConflict | null>(null), saving = useRef(false)
  const [rolled, setRolled] = useState(false), [focusTime, setFocusTime] = useState(false), [exact, setExact] = useState(false), [textHint, setTextHint] = useState(false)
  // One client_id (= Idempotency-Key) per body: a retry after a dropped answer reuses it, so a task that was saved but not answered cannot be added twice.
  const keys = useRef(new Map<string, string>())
  const online = useOnline(), [params, setParams] = useSearchParams()
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
  const read = readCapture(text), { plan, passed } = quickPlan(read, when, day)
  // The day the phrase fixes (a day word WITH a time: then it wins over the tiles), and the tile that matches it.
  const textDay = read.time && read.day ? read.day : '', textChoice = textDay ? choiceOf(textDay) : null
  const cleaned = read.title !== read.task.title, title = exact ? read.task.title : read.title
  const words = plan && planWords(plan, language, t)
  const booking = words
    ? <><bdi>{words.day}</bdi>{' '}<bdi dir="ltr">{words.from}–{words.endDay && <>{words.endDay} </>}{words.to}</bdi>{rolled && !textDay && <> {t('(today is almost over)', '(فات وقت اليوم)', '(vandaag is bijna voorbij)')}</>}</>
    : passed ? <>{t('', 'مضى ', '')}<bdi dir="ltr">{passed}</bdi>{t(' has passed: it will be added without a time', ': ستُضاف دون وقت', ' is voorbij: de taak wordt zonder tijd toegevoegd')}</>
    : read.found.duration ? t(`${read.task.estimated_minutes} min`, `${read.task.estimated_minutes} دقيقة`, `${read.task.estimated_minutes} min`) : null
  // The title that will be saved follows the booking, so the line reads «Understood: Tomorrow 10:00–10:30 · “Call the bank”».
  const understood = booking && <>{booking}{cleaned && !exact && <> · <bdi>{t(`“${title}”`, `«${title}»`, `“${title}”`)}</bdi></>}</>
  /** The task as it is saved: never a deadline; `starts_at` only when a day is chosen (or the phrase said when). */
  function task(booked: QuickPlan | null): NewTask {
    return { title, estimated_minutes: read.task.estimated_minutes, status: 'todo', priority, ...(booked ? { schedule: { starts_at: booked.starts_at } } : {}) }
  }
  function close() {
    setOpen(false)
    if (params.get('add')) setParams(p => { p.delete('add'); return p }, { replace: true })
    keys.current.clear()
    setText(''); setWhen('none'); setDay(''); setPriority('medium'); setVoice(false); setConflict(null); setRolled(false); setError(''); setExact(false); setTextHint(false) }
  /** The full form, with the title, the priority and the planned day, start and length already filled in (the deadline stays off). */
  function openDetails(startsAt?: string, onTime = false) {
    const { plan: booked } = quickPlan(read, when, day, new Date(), startsAt)
    setFocusTime(onTime)
    setDraft({ title, estimated_minutes: read.task.estimated_minutes, status: 'todo', priority, ...(booked ? { planned: { starts_at: booked.starts_at } } : {}) }); close()
  }
  const choose = (next: QuickDay) => { setWhen(next); setRolled(false); setError('') }
  /** While the phrase says the day, a tile does not change it (the phrase wins): the matching tile does nothing, another one says why. */
  const tap = (value: QuickDay, on: () => void) => () => { if (!textDay) on(); else if (value !== textChoice) setTextHint(true) }
  /** Today: the dialog's default start; with no half hour left today it is tomorrow, and the tile says so. */
  const chooseToday = () => { if (defaultWhen(accountDay()).day === accountDay()) choose('today'); else { choose('tomorrow'); setRolled(true) } }
  /** `startsAt`: the start the user accepted from a conflict's suggestion. Sent once: a second tap while this runs sends nothing. */
  async function save(e?: FormEvent, startsAt?: string) {
    e?.preventDefault()
    if (!text.trim() || saving.current) return
    const { plan: booked, passed: gone } = quickPlan(read, when, day, new Date(), startsAt)
    saving.current = true; setBusy(true); setError('')
    const body = task(booked), signature = JSON.stringify(body), clientId = keys.current.get(signature) ?? newIdempotencyKey()
    keys.current.set(signature, clientId)
    try {
      const result = await createTaskOrQueue(body, clientId)
      keys.current.delete(signature)
      // Kept on this device: lists are not reloaded, so what is on screen stays while offline.
      if (result === 'created') { window.dispatchEvent(new Event(TASKS_CHANGED)); if (booked) window.dispatchEvent(new Event(CALENDAR_CHANGED)) }
      const w = booked && planWords(booked, language, t), when_ = w && isolate(language, `${w.day} ${w.from}–${w.endDay ? `${w.endDay} ` : ''}${w.to}`)
      toast(result === 'queued' ? (booked ? t('Saved on this device. The time is checked again when you send it from “Waiting to sync”.', 'حُفظت على هذا الجهاز. يُتحقق من الوقت مجددًا عند إرسالها من «بانتظار المزامنة».', 'Op dit apparaat bewaard. De tijd wordt opnieuw gecontroleerd als je het verstuurt vanuit “Wacht op synchronisatie”.') : t('Saved on this device. Send it from “Waiting to sync” when you’re online.', 'حُفظت على هذا الجهاز. أرسلها من «بانتظار المزامنة» عند الاتصال.', 'Op dit apparaat bewaard. Verstuur het vanuit “Wacht op synchronisatie” als je online bent.'))
        : when_ ? t(`Added and scheduled: ${when_}`, `أُضيفت وجُدولت ${when_}`, `Toegevoegd en ingepland: ${when_}`)
        : gone ? t(`Added. ${gone} has passed, so it was not scheduled.`, `أُضيفت. الساعة ${isolate(language, gone)} مضت، لذا لم تُجدول.`, `Toegevoegd. ${gone} is voorbij, dus de taak is niet ingepland.`)
        : t('Task added.', 'أُضيفت المهمة.', 'Taak toegevoegd.'))
      close()
    } catch (err) {
      // A final answer (4xx) means nothing was saved: the next try is a new action. A dropped connection or a 5xx may have saved it: the retry keeps its client_id.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) keys.current.delete(signature)
      // A taken time: nothing was saved, the sheet stays with its text, and the dialog says what is in the way.
      const taken = parseConflict(err)
      if (taken) setConflict(taken)
      else if (err instanceof ApiError && err.status === 422 && (err.errors?.['schedule.ends_at'] || err.errors?.['schedule.starts_at'])) setError(t('Choose a time that has not passed.', 'اختر وقتًا لم يمضِ.', 'Kies een tijd die nog niet voorbij is.'))
      else setError((err as Error).message)
    } finally { saving.current = false; setBusy(false) }
  }
  const icon = (Icon: typeof Sun) => <Icon size={20} aria-hidden="true" />
  const heading = t('When do you want to do it?', 'متى تريد تنفيذها؟', 'Wanneer wil je het doen?')
  const choice = textChoice ?? (when === 'custom' ? choiceOf(day) === 'custom' ? 'custom' : choiceOf(day) : when), pickedDay = textChoice ? textDay : day
  const fromId = `${noteId}-from`, fromText = <span id={fromId} className="qa-from" aria-hidden="true">{t('from your text', 'من نصّك', 'uit je tekst')}</span>
  const textDayWord = textChoice === 'today' ? t('today', 'اليوم', 'vandaag') : textChoice === 'tomorrow' ? t('tomorrow', 'غدًا', 'morgen') : textDay ? dayLabel(textDay, language) : ''
  const tile = (value: QuickDay, label: string, Icon: typeof Sun, on: () => void) => <button key={value} type="button" role="radio" aria-checked={choice === value} aria-describedby={textChoice === value ? fromId : undefined} className="choice" onClick={tap(value, on)}><span className="choice-icon">{icon(Icon)}</span><span className="choice-label">{label}</span>{textChoice === value && fromText}</button>
  const priorities: { value: Priority; label: string; icon: ReactNode; tone: string }[] = [{ value: 'urgent', label: t('Urgent', 'عاجل'), icon: icon(Flame), tone: 'urgent' }, { value: 'high', label: t('High', 'عالية'), icon: icon(ArrowUp), tone: 'high' }, { value: 'medium', label: t('Normal', 'عادية'), icon: icon(Equal), tone: 'medium' }, { value: 'low', label: t('Low', 'منخفضة'), icon: icon(ArrowDown), tone: 'low' }]
  return <>
    {shown && <BottomSheet title={t('Quick add', 'إضافة سريعة')} onClose={close} dirty={() => text.trim() !== ''} footer={
      <button type="submit" form="quick-add-form" className="primary qa-add" aria-disabled={busy || undefined} disabled={!text.trim()}><Plus size={20} aria-hidden="true" />{t('Add task', 'إضافة المهمة')}</button>}>
      <form id="quick-add-form" className="quick-add" onSubmit={e => void save(e)}>
        <div className="quick-add-input">
          <input data-autofocus className="qa-title" value={text} maxLength={200} onChange={e => { setText(e.target.value); setError(''); setTextHint(false) }} aria-label={t('Task', 'المهمة')} aria-invalid={error ? true : undefined} aria-describedby={[understood ? noteId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined} placeholder={t('What needs doing?', 'ما الذي يجب إنجازه؟')} enterKeyHint="done" autoComplete="off" autoCapitalize="sentences" />
          {voiceAllowed && <Suspense fallback={null}><VoiceButton autoStart={voice} onText={said => { setText(v => `${v.trimEnd()}${v.trim() ? ' ' : ''}${said}`.slice(0, 200)); const hints = spokenHints(said); if (hints.when === 'nextweek') { setDay(nextWeekDay()); choose('custom') } else if (hints.when === 'tomorrow') choose('tomorrow'); if (hints.priority) setPriority(hints.priority) }} /></Suspense>}
        </div>
        {understood && <p id={noteId} className="muted small qa-understood">{t('Understood: ', 'فُهم: ', 'Begrepen: ')}{understood}</p>}
        {cleaned && <label className="inline muted qa-exact"><input type="checkbox" checked={exact} onChange={e => setExact(e.target.checked)} />{t('Keep my exact text', 'احتفظ بنصي كما هو', 'Mijn tekst precies bewaren')}</label>}
        <div className="field-block">
          <span className="field-title" id={`${noteId}-when`}>{heading}</span>
          <div className="qa-whens rf-whens" role="radiogroup" aria-labelledby={`${noteId}-when`}>
            {tile('today', t('Today', 'اليوم', 'Vandaag'), Sun, chooseToday)}
            {tile('tomorrow', t('Tomorrow', 'غدًا', 'Morgen'), Sunrise, () => choose('tomorrow'))}
            {/* While the phrase says the day, the date chooser does not open (the phrase would win anyway): a tap says how to change it. */}
            <span className={`qa-pick${choice === 'custom' ? ' is-set' : ''}`} onClickCapture={textDay ? e => { e.preventDefault(); e.stopPropagation(); setTextHint(true) } : undefined}><DateTimeField kind="date" value={choice === 'custom' ? pickedDay : ''} min={accountDay()} onChange={v => { setDay(v); choose(v ? 'custom' : 'none') }} label={t('Pick a date', 'تاريخ آخر', 'Andere datum')} placeholder={t('Pick a date', 'تاريخ آخر', 'Andere datum')} shown={choice === 'custom' ? dayLabel(pickedDay, language) : undefined} radioChecked={choice === 'custom'} describedBy={textChoice === 'custom' ? fromId : undefined} />{textChoice === 'custom' && fromText}</span>
            {tile('none', t('Not scheduled', 'بدون جدولة', 'Niet ingepland'), CalendarX, () => choose('none'))}
          </div>
          <span role="status" className="muted qa-day-note">{textDay && textHint ? t(`Your text says ${textDayWord}; remove it from the text to choose another day`, `نصّك يقول ${textDayWord}؛ احذفه من النص لتختار يومًا آخر`, `Je tekst zegt ${textDayWord}; haal het uit de tekst om een andere dag te kiezen`) : ''}</span>
        </div>
        <PrayerOverlapNote start={plan?.starts_at} end={plan?.ends_at} />
        <ChoiceGroup label={t('Priority', 'الأولوية')} variant="tiles" columns={4} value={priority} onChange={setPriority} options={priorities} />
        <div className="qa-more">
          <button type="button" className="quiet quick-habit" onClick={() => { close(); openHabitSheet() }}><Heart size={18} aria-hidden="true" />{t('Log a habit', 'سجّل عادة')}</button>
          <button type="button" className="quiet" disabled={!text.trim()} onClick={() => openDetails()}><SlidersHorizontal size={18} aria-hidden="true" />{t('More details', 'تفاصيل أكثر')}</button>
        </div>
        {!online && <p className="offline-note" role="status"><WifiOff size={14} aria-hidden="true" />{t('You’re offline. The task is kept on this device until you send it.', 'أنت غير متصل. تُحفظ المهمة على هذا الجهاز حتى ترسلها.')}</p>}
        {error && <p id={errorId} role="alert" className="error">{error}</p>}
      </form>
      {conflict && <Suspense fallback={null}><ScheduleConflictDialog key={conflict.requested.starts_at} conflict={conflict} onClose={() => setConflict(null)} onChoose={() => openDetails(conflict.requested.starts_at, true)}
        onUseSuggestion={slot => { setConflict(null); void save(undefined, slot.starts_at) }} /></Suspense>}
    </BottomSheet>}
    {draft && <Suspense fallback={null}><RecordForm resource="tasks" focusTime={focusTime} item={draft} onSave={() => window.dispatchEvent(new Event(TASKS_CHANGED))} onClose={() => setDraft(null)} /></Suspense>}
  </>
}
