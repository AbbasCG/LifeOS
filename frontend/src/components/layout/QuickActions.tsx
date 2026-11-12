import { isAllDay, moveDue, restoreDue } from '../../lib/dueDate'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Check, Flame, Heart } from 'lucide-react'
import { api, type RecordItem } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { localDate } from '../../lib/hooks'
import { startFocus, POMODORO } from '../../lib/focus'
import { completeTaskOrQueue, logHabitOrQueue } from '../../lib/offline'
import { TASKS_CHANGED, dueFor } from '../../lib/quickAdd'
import { doneNow, HABIT_SHEET, HABITS_CHANGED, type Habit } from '../../lib/quickActions'
import { BottomSheet, EmptyNote } from '../visual'
import { ErrorMessage } from '../ui/Shared'

/**
 * One-tap actions arriving as links — from notification buttons, the installed app's shortcuts or the in-app
 * notification list — and the habit sheet. Every action is the user's own tap; each one can be undone.
 *   /?habit=ID&done=1  log that habit for today (Undo)     /?habit=ID or /?log=habits  open the habit sheet
 *   /?focus=start      start a 25-minute focus session      /?focus=break  start a 5-minute break
 *   /?task=ID&done=1   complete that task (Undo)            /?task=ID&snooze=hour|tomorrow  remind again in an hour, or move the due date to tomorrow (Undo)
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

  const completeTask = useCallback(async (id: number) => {
    try {
      const task = (await api<{ data: RecordItem }>(`/api/tasks/${id}`)).data
      if (task.status === 'completed') { toast(t(`“${task.title}” is already done.`, `«${task.title}» منجزة بالفعل.`)); return }
      const result = await completeTaskOrQueue(task)
      window.dispatchEvent(new Event(TASKS_CHANGED))
      if (result === 'queued') { toast(t('Saved on this device. Send it from “Waiting to sync” when you’re online.', 'حُفظ على هذا الجهاز. أرسله من «بانتظار المزامنة» عند الاتصال.')); return }
      toast(t(`Done: “${task.title}”.`, `تم: «${task.title}».`), 'success', { label: t('Undo', 'تراجع'), onClick: () => void api(`/api/tasks/${id}`, 'PATCH', { status: task.status ?? 'todo' }).then(() => window.dispatchEvent(new Event(TASKS_CHANGED))) })
    } catch (e) { toast((e as Error).message || t('That task could not be completed.', 'تعذّر إنجاز المهمة.'), 'error') }
  }, [t, toast])

  const snoozeTask = useCallback(async (id: number, kind: 'hour' | 'tomorrow') => {
    try {
      const task = (await api<{ data: RecordItem }>(`/api/tasks/${id}`)).data
      const before = kind === 'hour' ? { remind_at: (task.remind_at as string | null | undefined) ?? null } : restoreDue(task)
      const after = kind === 'hour' ? { remind_at: new Date(Date.now() + 3600_000).toISOString() } : (isAllDay(task) ? moveDue('tomorrow', task) : { due_at: dueFor('tomorrow') })
      await api(`/api/tasks/${id}`, 'PATCH', after)
      window.dispatchEvent(new Event(TASKS_CHANGED))
      toast(kind === 'hour' ? t(`“${task.title}” will remind you again in an hour.`, `ستذكّرك «${task.title}» مجدداً بعد ساعة.`) : t(`“${task.title}” moved to tomorrow.`, `نُقلت «${task.title}» إلى الغد.`), 'success',
        { label: t('Undo', 'تراجع'), onClick: () => void api(`/api/tasks/${id}`, 'PATCH', before).then(() => window.dispatchEvent(new Event(TASKS_CHANGED))) })
    } catch (e) { toast((e as Error).message || t('That task could not be changed.', 'تعذّر تعديل المهمة.'), 'error') }
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
    const task = Number(params.get('task')) || null, snooze = params.get('snooze')
    // A task link without an action ("/tasks?task=ID") only opens that task's row on the Tasks page; it is not touched here.
    const taskAction = task && (done || snooze === 'hour' || snooze === 'tomorrow')
    if ((!habit && log !== 'habits' && !focusAction && !taskAction)) return
    const key = `${habit}|${done}|${log}|${focusAction}|${task}|${snooze}`
    if (handled.current === key) return
    handled.current = key
    setParams(p => { for (const name of ['habit', 'done', 'log', 'focus', 'task', 'snooze']) p.delete(name); return p }, { replace: true })
    if (taskAction && task) { if (done) void completeTask(task); else void snoozeTask(task, snooze as 'hour' | 'tomorrow'); return }
    if (habit && done) void logHabit(habit)
    else if (habit || log === 'habits') window.dispatchEvent(new CustomEvent(HABIT_SHEET, { detail: habit }))
    else if (focusAction === 'start' || focusAction === 'break') void focus(focusAction === 'start' ? 'focus' : 'short_break')
  }, [params, setParams, logHabit, focus, completeTask, snoozeTask])

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
