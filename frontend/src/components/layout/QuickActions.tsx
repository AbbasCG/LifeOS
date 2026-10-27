import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Check, Flame, Heart } from 'lucide-react'
import { api } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { localDate } from '../../lib/hooks'
import { startFocus, POMODORO } from '../../lib/focus'
import { logHabitOrQueue } from '../../lib/offline'
import { doneNow, HABIT_SHEET, HABITS_CHANGED, type Habit } from '../../lib/quickActions'
import { BottomSheet, EmptyNote } from '../visual'
import { ErrorMessage } from '../ui/Shared'

/**
 * One-tap actions arriving as links — from notification buttons, the installed app's shortcuts or the in-app
 * notification list — and the habit sheet. Every action is the user's own tap; each one can be undone.
 *   /?habit=ID&done=1  log that habit for today (Undo)     /?habit=ID or /?log=habits  open the habit sheet
 *   /?focus=start      start a 25-minute focus session      /?focus=break  start a 5-minute break
 */
export default function QuickActions() {
  const t = useText(), toast = useToast(), navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState(false), [highlight, setHighlight] = useState<number | null>(null)
  const handled = useRef('')

  const logHabit = useCallback(async (id: number) => {
    try {
      const habit = (await api<{ data: Habit }>(`/api/habits/${id}`)).data
      const date = localDate()
      await api(`/api/habits/${id}/entry`, 'PUT', { date, completed: true })
      window.dispatchEvent(new Event(HABITS_CHANGED))
      toast(t(`Logged “${habit.title}”.`, `سُجّلت «${habit.title}».`), 'success', { label: t('Undo', 'تراجع'), onClick: () => void api(`/api/habits/${id}/entry`, 'PUT', { date, completed: false }).then(() => { window.dispatchEvent(new Event(HABITS_CHANGED)); toast(t('Undone.', 'تم التراجع.')) }) })
    } catch (e) { toast((e as Error).message || t('That habit could not be logged.', 'تعذّر تسجيل العادة.'), 'error') }
  }, [t, toast])

  const focus = useCallback(async (kind: 'focus' | 'short_break') => {
    try {
      const result = await startFocus(null, kind === 'focus' ? POMODORO.focus : POMODORO.short, kind)
      if (result === 'already_running') toast(t('A session is already running.', 'هناك جلسة قيد التشغيل بالفعل.'))
      navigate('/focus')
    } catch (e) { toast((e as Error).message, 'error') }
  }, [navigate, t, toast])

  // Listen before acting on links below: effects run in order, and a link may open the sheet.
  useEffect(() => {
    const show = (e: Event) => { setHighlight((e as CustomEvent<number | null>).detail ?? null); setOpen(true) }
    window.addEventListener(HABIT_SHEET, show)
    return () => window.removeEventListener(HABIT_SHEET, show)
  }, [])

  // Act on a link once, then remove its parameters so a reload or Back never repeats it.
  useEffect(() => {
    const habit = Number(params.get('habit')) || null, done = params.get('done') === '1', log = params.get('log'), focusAction = params.get('focus')
    const key = `${habit}|${done}|${log}|${focusAction}`
    if ((!habit && log !== 'habits' && !focusAction) || handled.current === key) return
    handled.current = key
    setParams(p => { for (const name of ['habit', 'done', 'log', 'focus']) p.delete(name); return p }, { replace: true })
    if (habit && done) void logHabit(habit)
    else if (habit || log === 'habits') window.dispatchEvent(new CustomEvent(HABIT_SHEET, { detail: habit }))
    else if (focusAction === 'start' || focusAction === 'break') void focus(focusAction === 'start' ? 'focus' : 'short_break')
  }, [params, setParams, logHabit, focus])

  return open ? <HabitSheet highlight={highlight} onClose={() => setOpen(false)} /> : null
}

/** Today's habits with one-tap ticks (tap again to undo); the habit a reminder pointed to comes first. */
function HabitSheet({ highlight, onClose }: { highlight: number | null; onClose: () => void }) {
  const t = useText(), toast = useToast()
  const [habits, setHabits] = useState<Habit[] | null>(null), [busy, setBusy] = useState<number | null>(null), [error, setError] = useState('')
  const load = useCallback(() => api<{ data: Habit[] }>('/api/habits?per_page=100').then(r => setHabits(r.data)).catch(e => setError((e as Error).message)), [])
  useEffect(() => { void load() }, [load])
  async function toggle(habit: Habit) {
    setBusy(habit.id); setError('')
    try {
      const date = localDate(), completed = !doneNow(habit)
      if (await logHabitOrQueue(habit, date, completed) === 'queued') {
        // Kept on this device: show the tick now; it is sent from "Waiting to sync".
        setHabits(list => list && list.map(h => h.id !== habit.id ? h : { ...h, entries: completed ? [...(h.entries ?? []), { date }] : (h.entries ?? []).filter(e => e.date !== date) }))
        toast(t('Saved on this device. Send it from “Waiting to sync” when you’re online.', 'حُفظ على هذا الجهاز. أرسله من «بانتظار المزامنة» عند الاتصال.'))
        return
      }
      window.dispatchEvent(new Event(HABITS_CHANGED))
      await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const today = localDate()
  return <BottomSheet title={t('Log a habit', 'سجّل عادة')} onClose={onClose}>
    <ErrorMessage error={error} />
    {habits === null ? <p className="muted">{t('Loading…', 'جارٍ التحميل…')}</p> : habits.length === 0
      ? <EmptyNote icon={Heart} text={t('No habits yet.', 'لا توجد عادات بعد.')} />
      : <ul className="habit-sheet">{[...habits].sort((a, b) => Number(b.id === highlight) - Number(a.id === highlight)).map(habit => {
        const done = doneNow(habit, today)
        return <li key={habit.id} className={habit.id === highlight ? 'highlight' : ''}>
          <button type="button" className={`tick ${done ? 'done' : ''}`} aria-pressed={done} disabled={busy === habit.id} onClick={() => void toggle(habit)} aria-label={done ? t(`Undo “${habit.title}”`, `تراجع عن «${habit.title}»`) : t(`Log “${habit.title}”`, `سجّل «${habit.title}»`)}><Check size={18} /></button>
          <span className="habit-sheet-title"><strong>{habit.title}</strong><small className="muted">{habit.recurrence === 'weekly' ? t('Weekly', 'أسبوعية') : t('Daily', 'يومية')}{habit.remind_time ? ` · ${habit.remind_time}` : ''}</small></span>
          {(habit.current_streak ?? 0) > 0 && <span className="streak-pill" title={t('Current streak', 'السلسلة الحالية')}><Flame size={13} aria-hidden="true" />{habit.current_streak}</span>}
        </li>
      })}</ul>}
  </BottomSheet>
}
