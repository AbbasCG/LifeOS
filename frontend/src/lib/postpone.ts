import { api, ApiError, type RecordItem } from './api'
import { accountDay, accountZone } from './accountDay'
import { formatClock, formatDayText } from './clock'
import { newIdempotencyKey, notifyScheduleChanged } from './taskSchedule'
import type { ToastApi } from './toast'

/**
 * Smart postpone (POST /api/tasks/{id}/postpone): one tap moves a task's next session (same row, same length) to the first free time of
 * tomorrow, of next week or of a chosen day, or only its deadline when it has no session; Undo puts it back exactly (10 minutes).
 * 'suggest' writes nothing and answers with the best day. Every rule is the server's; this file only sends and words the answer.
 */
export type PostponeTo = 'tomorrow' | 'next_week' | 'date'
export type PostponeBody = { to: PostponeTo; date?: string; expected_updated_at?: string }
export type PostponeMoved = {
  session?: { session_id: number; from_starts_at: string; from_ends_at: string; starts_at: string; ends_at: string }
  due?: { from: string | null; to: string; due_all_day: boolean }
}
export type PostponeResult = { data: RecordItem; undo: { token: string; expires_at: string }; moved: PostponeMoved }
export type PostponeSuggestion = { to: 'date'; date: string; starts_at: string | null; ends_at: string | null; due_at: string | null; due_all_day: boolean; has_room: boolean }
type Words = (en: string, ar: string, nl?: string) => string
export type PostponeTools = { t: Words; toast: ToastApi; language: string }
/** What a task needs to be postponed from any list: its id, and (when known) the version the person was looking at. */
export type PostponeTask = { id: number; updated_at?: unknown }

/** Completed and cancelled tasks are never postponed (the server refuses them too), so the control is not offered for them. */
export const canPostpone = (task: { status?: unknown }) => !['completed', 'cancelled'].includes(String(task.status ?? ''))

/** The body for a target, with the version the person saw so a change made elsewhere meanwhile is refused (409) instead of overwritten. */
export function postponeBody(task: PostponeTask, to: PostponeTo, date?: string): PostponeBody {
  return { to, ...(to === 'date' ? { date } : {}), ...(typeof task.updated_at === 'string' ? { expected_updated_at: task.updated_at } : {}) }
}

export const suggestPostpone = (taskId: number) =>
  api<{ data: RecordItem; suggestion: PostponeSuggestion }>(`/api/tasks/${taskId}/postpone`, 'POST', { to: 'suggest' })

/** "Thu" for a day in the coming week, "Thu, Dec 3" further away, in the account's zone. */
export function dayWord(iso: string, language: string): string {
  const zone = accountZone(), days = (Date.parse(`${accountDay(new Date(iso))}T00:00Z`) - Date.parse(`${accountDay()}T00:00Z`)) / 86_400_000
  return formatDayText(iso, { language, timeZone: zone }, days >= 0 && days < 7 ? { weekday: 'short' } : undefined)
}
const clock = (iso: string) => formatClock(iso, { timeZone: accountZone() })

/** "Moved to Thu 09:00–10:00" for a session, "Deadline moved to Thu" (with its time when it has one) when only the deadline moved. */
export function movedText(moved: PostponeMoved, t: Words, language: string): string {
  if (moved.session) {
    const when = `${dayWord(moved.session.starts_at, language)} ${clock(moved.session.starts_at)}–${clock(moved.session.ends_at)}`
    return t(`Moved to ${when}`, `نُقلت إلى ${when}`, `Verplaatst naar ${when}`)
  }
  if (moved.due) {
    const when = dayWord(moved.due.to, language) + (moved.due.due_all_day ? '' : ` ${clock(moved.due.to)}`)
    return t(`Deadline moved to ${when}`, `نُقل الموعد النهائي إلى ${when}`, `Deadline verplaatst naar ${when}`)
  }
  return t('Postponed.', 'أُجّلت.', 'Uitgesteld.')
}

/** The answer for a refusal, in the person's language; anything unknown keeps the server's own message. `undo` words a refused undo. */
export function postponeError(error: unknown, t: Words, undo = false): string {
  if (!(error instanceof ApiError)) return (error as Error)?.message ?? String(error)
  const conflict = (error.data.conflict as { code?: unknown } | undefined)?.code === 'schedule_conflict'
  const code = error.code ?? (conflict ? 'schedule_conflict' : undefined)
  switch (code) {
    case 'session_fixed': return t('This is a fixed appointment; move it in the calendar.', 'هذا موعد ثابت؛ انقله من التقويم.', 'Dit is een vaste afspraak; verplaats hem in de agenda.')
    case 'session_linked': return t('This session is also in a connected calendar; move it there.', 'هذه الجلسة منسوخة إلى تقويم مرتبط؛ انقلها من هناك.', 'Deze sessie staat ook in een gekoppelde agenda; verplaats hem daar.')
    case 'nothing_to_postpone': return t('This task has no session and no deadline, so there is nothing to postpone.', 'ليس لهذه المهمة جلسة ولا موعد نهائي، فلا شيء لتأجيله.', 'Deze taak heeft geen sessie en geen deadline, dus er is niets uit te stellen.')
    case 'already_later': return t('The deadline is already on or after that day.', 'الموعد النهائي في ذلك اليوم أو بعده بالفعل.', 'De deadline valt al op of na die dag.')
    case 'task_closed': return t('A completed or cancelled task cannot be postponed.', 'لا يمكن تأجيل مهمة منجزة أو ملغاة.', 'Een afgeronde of geannuleerde taak kan niet worden uitgesteld.')
    case 'task_changed': return t('This task was changed in the meantime. Reload and try again.', 'تغيّرت هذه المهمة في هذه الأثناء. أعد التحميل وحاول مجدداً.', 'Deze taak is intussen gewijzigd. Laad opnieuw en probeer het nog eens.')
    case 'changed_since': return t('This task was changed after it was postponed, so it is not put back.', 'تغيّرت هذه المهمة بعد تأجيلها، فلم تُعد كما كانت.', 'Deze taak is na het uitstellen gewijzigd, dus hij wordt niet teruggezet.')
    case 'undo_unavailable': return t('This postponement can no longer be undone.', 'لم يعد بالإمكان التراجع عن هذا التأجيل.', 'Dit uitstel kan niet meer ongedaan worden gemaakt.')
    case 'schedule_conflict': return undo
      ? t(error.message, 'الوقت الأصلي لم يعد متاحاً، فلم تُعد الجلسة إليه.', 'De oorspronkelijke tijd is niet meer vrij, dus de sessie wordt niet teruggezet.')
      : t(error.message, 'لا يوجد وقت فارغ لهذه الجلسة في ذلك اليوم ولا في أيام العمل التالية.', 'Er is geen vrije tijd voor deze sessie op die dag of de volgende werkdagen.')
    default: return error.message
  }
}

/** Puts a postponement back (once, within its window). The result is said in a toast; the lists, Today and the calendar read the server again. */
export async function undoPostpone(taskId: number, token: string, { t, toast }: PostponeTools) {
  try {
    await api(`/api/tasks/${taskId}/postpone/undo`, 'POST', { token })
    toast(t('Put back where it was.', 'أُعيدت إلى حيث كانت.', 'Teruggezet waar hij stond.'))
  } catch (e) { toast(postponeError(e, t, true), 'error') } finally { notifyScheduleChanged() }
}

/**
 * Sends the postponement with an Idempotency-Key (the same key for a retry of the same tap), then says what moved with an Undo, and
 * has every view read the server again. A refusal is thrown for the caller to show where the person is.
 */
export async function postponeTask(task: PostponeTask, body: PostponeBody, tools: PostponeTools, key = newIdempotencyKey()): Promise<PostponeResult> {
  let result: PostponeResult
  try { result = await api<PostponeResult>(`/api/tasks/${task.id}/postpone`, 'POST', body, { 'Idempotency-Key': key }) }
  catch (e) {
    // The task changed elsewhere: read it again, so the next tap is made on what is there now.
    if (e instanceof ApiError && e.status === 409) notifyScheduleChanged()
    throw e
  }
  notifyScheduleChanged()
  const { t, toast, language } = tools
  toast(movedText(result.moved ?? {}, t, language), 'success', { label: t('Undo', 'تراجع', 'Ongedaan maken'), onClick: () => void undoPostpone(task.id, result.undo.token, tools) })
  return result
}
