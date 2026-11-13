import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, CalendarDays, ChevronDown, Equal, Flag, Flame, FolderKanban, Plus, Repeat, Tags, X } from 'lucide-react'
import { api, ApiError, type RecordItem } from '../lib/api'
import { useRecords } from '../lib/hooks'
import { draftOf, duePayload } from '../lib/dueDate'
import { DEFAULT_DEADLINE_TIME, TASKS_CHANGED, deadlineField, deadlineInstant, whenField } from '../lib/quickAdd'
import { CALENDAR_CHANGED, newIdempotencyKey, notifyScheduleChanged } from '../lib/taskSchedule'
import { parseConflict, type ScheduleConflict } from '../lib/scheduleConflict'
import { ExecutionSection } from './tasks/ExecutionTime'
import { useExecution } from './tasks/useExecution'
import { ScheduleConflictDialog } from '../components/ui/ScheduleConflictDialog'
import { DateTimeField } from '../components/ui/DateTimePicker'
import { ZoneNote } from '../components/ui/ZoneNote'
import { typedTimesShifted } from '../lib/zoneShift'
import { ChoiceGroup, PickerField, type ChoiceOption } from '../components/ui/Choice'
import { BottomSheet, SheetCancel } from '../components/visual'
import { ErrorMessage } from '../components/ui/Shared'
import { useText } from '../lib/i18n'
import { useToast } from '../lib/toast'

const NL: Record<string, string> = {"Active": "Actief", "Add milestone": "Mijlpaal toevoegen", "Add subtask": "Subtaak toevoegen", "Cancel": "Annuleren", "Cancelled": "Geannuleerd", "Category": "Categorie", "Changes saved.": "Wijzigingen opgeslagen.", "Color": "Kleur", "Completed": "Voltooid", "Create item": "Item maken", "Created.": "Gemaakt.", "Daily": "Dagelijks", "Deadline": "Deadline", "Description": "Beschrijving", "Does not repeat": "Herhaalt niet", "Edit item": "Item bewerken", "End": "Einde", "Fixed commitment": "Vaste afspraak", "Flexible block": "Flexibel blok", "Goal": "Doel", "High": "Hoog", "In progress": "Bezig", "Inbox": "Inbox", "Low": "Laag", "Medium": "Gemiddeld", "Milestone title": "Titel van mijlpaal", "Milestones": "Mijlpalen", "More options": "Meer opties", "Morning, evening…": "Ochtend, avond…", "Notes": "Notities", "Paused": "Gepauzeerd", "Personal": "Persoonlijk", "Priority": "Prioriteit", "Progress": "Voortgang", "Project": "Project", "Recurrence": "Herhaling", "Remind me": "Herinner mij", "Remind me at": "Herinner mij om", "Remove": "Verwijderen", "Repeat": "Herhalen", "Routine": "Routine", "Save": "Opslaan", "Saving…": "Opslaan…", "Start": "Start", "Status": "Status", "Study": "Studie", "Subtask title": "Titel van subtaak", "Subtasks": "Subtaken", "Tags (comma separated)": "Labels (komma-gescheiden)", "Target": "Streefwaarde", "Task": "Taak", "This is a fixed commitment. I confirm I want to change its time.": "Dit is een vaste afspraak. Ik bevestig dat ik de tijd wil wijzigen.", "Time boundary": "Tijdsgrens", "Title": "Titel", "To do": "Te doen", "Type": "Type", "Until it’s logged that day (week, for weekly habits).": "Tot het die dag is vastgelegd (week, bij wekelijkse gewoonten).", "Urgent": "Urgent", "Weekly": "Wekelijks", "Work (default)": "Werk (standaard)"}
/** `t` for this dialog: the usual three-language text, with Dutch for every English phrase listed above (others pass their own). */
function useT() { const base = useText(); return (en: string, ar: string, nl?: string) => base(en, ar, nl ?? NL[en]) }
const STATUSES = ['inbox', 'todo', 'in_progress', 'completed', 'cancelled']
export function useStatusLabel() { const t = useT(); return (s: string) => ({ inbox: t('Inbox', 'الوارد'), todo: t('To do', 'للإنجاز'), in_progress: t('In progress', 'قيد التنفيذ'), completed: t('Completed', 'مكتمل'), cancelled: t('Cancelled', 'ملغى'), low: t('Low', 'منخفضة'), medium: t('Medium', 'متوسطة'), high: t('High', 'عالية'), urgent: t('Urgent', 'عاجلة'), active: t('Active', 'نشط'), paused: t('Paused', 'متوقف') }[s] || s) }

/** A saved instant as the date fields show it: the account's wall clock ('' for none); posted back as that wall time's instant. */
const fieldOf = deadlineField
type Step = { title: string; completed: boolean }

/**
 * Create / edit any item (task, project, goal, habit, category, event) in a bottom sheet on phones and a centred card elsewhere.
 * The Save button lives in the sheet's footer, so it is never scrolled out of sight. Short lists of options are one-tap choices (no
 * drop-downs); long lists (project, goal, category, task) are a searchable picker; rarely used fields sit under "More options".
 * The posted data is the same as the old form's, field for field.
 */
export function RecordForm({ resource, item, onSave, onClose }: { resource: string; item: Partial<RecordItem>; onSave: () => void; onClose: () => void }) {
  const t = useT(), label = useStatusLabel(), toast = useToast()
  const saving = useRef(false), helperId = useId(), zoneId = useId(), explainId = useId(), removeDueId = useId()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const wantsLists = resource === 'tasks', projects = useRecords('projects'), categories = useRecords('categories'), goals = useRecords('goals'), tasks = useRecords('tasks')
  const [subtasks, setSubtasks] = useState<Step[]>((((resource === 'projects' || resource === 'goals') ? item.milestones : item.subtasks) as Step[]) || [])
  // Controlled values that the choice buttons set (each is also posted through a hidden input of the same name).
  const [status, setStatus] = useState(String(item.status || (resource === 'projects' ? 'active' : 'inbox')))
  const [priority, setPriority] = useState(String(item.priority || 'medium'))
  const [recurrence, setRecurrence] = useState(String(item.recurrence || (resource === 'habits' ? 'daily' : '')))
  const [openedDue] = useState(() => draftOf(item))
  const [due, setDue] = useState(openedDue.field), [noTime, setNoTime] = useState(openedDue.noTime)
  // «هل لديك موعد نهائي؟»: on when the task already has a deadline (kept untouched); off for a new task. Turning it off on a task that has one removes it.
  const [hasDeadline, setHasDeadline] = useState(Boolean(openedDue.field))
  const [conflict, setConflict] = useState<ScheduleConflict | null>(null)
  const keys = useRef(new Map<string, string>())
  const [pick, setPick] = useState<Record<string, string>>({ project_id: String(item.project_id || ''), goal_id: String(item.goal_id || ''), category_id: String(item.category_id || ''), task_id: String(item.task_id || '') })
  const [kind, setKind] = useState(String(item.kind || 'fixed')), [area, setArea] = useState(String(item.area || ''))
  const formId = `record-form-${resource}`
  // The day, start and length of the calendar session travel in the same request as the task (the server books or moves it atomically).
  const exec = useExecution(item), closed = status === 'completed' || status === 'cancelled'
  // A deadline earlier than the end of the session is said calmly (a date-only deadline ends with its day).
  const dueInstant = hasDeadline && due ? deadlineInstant(noTime ? `${due.slice(0, 10)}T23:59` : due) : null
  const lateAfter = !!dueInstant && !!exec.booking && exec.day !== '' && Date.parse(dueInstant) < Date.parse(exec.booking.ends_at)
  const removing = !hasDeadline && !!item.id && !!openedDue.field
  const pastMessage = t('Choose a time that has not passed.', 'اختر وقتًا لم يمضِ.', 'Kies een tijd die nog niet voorbij is.')
  // Unsaved work = any posted field or subtask that differs from what the form opened with (hidden inputs carry the choice buttons' values).
  const opened = useRef<string | null>(null)
  const snapshot = useCallback(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null
    return form ? JSON.stringify([[...new FormData(form)].map(([k, v]) => [k, String(v)]), subtasks, exec.signature, hasDeadline, due, noTime]) : null
  }, [formId, subtasks, exec.signature, hasDeadline, due, noTime])
  useEffect(() => { opened.current ??= snapshot() })
  const dirty = useCallback(() => { const now = snapshot(); return opened.current !== null && now !== null && now !== opened.current }, [snapshot])

  /** Back to where it was: Undo after "not scheduled" books the removed session again (the same endpoint the list chips use). */
  function restoreSession(slot: { starts_at: string; ends_at: string }) {
    const taskId = item.id
    api(`/api/tasks/${taskId}/schedule`, 'POST', slot, { 'Idempotency-Key': newIdempotencyKey() })
      .then(() => { toast(t('Back in the calendar.', 'أُعيدت إلى التقويم.', 'Terug in de agenda.')); notifyScheduleChanged() })
      .catch(err => toast(parseConflict(err) ? t('That time is no longer free.', 'هذا الوقت لم يعد متاحًا.', 'Die tijd is niet meer vrij.') : (err as Error).message, 'error'))
  }

  /** One request: the task and its execution time together. `over` is a day and start just filled in from a suggestion. */
  async function save(over?: { day: string; start: string }) {
    const form = document.getElementById(formId) as HTMLFormElement | null
    if (!form || saving.current) return   // a second click or Enter while the first save is still running sends nothing
    saving.current = true; setBusy(true); setError('')
    try {
      const data: Record<string, unknown> = Object.fromEntries(new FormData(form))
      // A field left as it opened keeps its saved instant (the repeated autumn hour would otherwise come back as its first reading).
      for (const key of ['due_at', 'remind_at', 'starts_at', 'ends_at']) if (key in data) {
        const field = String(data[key] ?? ''), original = item[key] as string | null | undefined
        data[key] = !field ? null : original && field === deadlineField(original) ? original : deadlineInstant(field)
      }
      if (resource === 'tasks') {
        // The deadline is its own thing: only when the switch is on, only when it changed, `due_date` for a deadline with no time. Never made from the execution time.
        delete data.due_at; delete data.due_date
        Object.assign(data, hasDeadline ? duePayload({ field: due, noTime }, item.id ? openedDue : null) : item.id && openedDue.field ? { due_at: null } : {})
        const plan = exec.payload(closed, over)
        if (!plan) { setError(t('Choose a start time and a duration of at least 5 minutes.', 'اختر وقت بداية ومدة لا تقل عن 5 دقائق.', 'Kies een starttijd en een duur van minstens 5 minuten.')); return }
        // A time that is already over (the start was picked earlier and has since passed) is said calmly, before anything is sent.
        const sched = plan.schedule
        if (sched && Date.parse(sched.starts_at) + plan.estimated_minutes * 60_000 <= Date.now()) { setError(pastMessage); return }
        Object.assign(data, plan)
      }
      for (const key of ['project_id', 'goal_id', 'category_id', 'task_id']) if (key in data) data[key] = data[key] ? Number(data[key]) : null
      if (resource === 'tasks') { data.subtasks = subtasks; data.tags = String(data.tags || '').split(',').map(s => s.trim()).filter(Boolean); data.recurrence = data.recurrence || null }
      if (resource === 'projects' || resource === 'goals') data.milestones = subtasks
      // One Idempotency-Key per user action: the same save sent again after a dropped connection carries the same key, so it cannot book twice.
      const signature = JSON.stringify(data), key = keys.current.get(signature) ?? newIdempotencyKey()
      if (resource === 'tasks') keys.current.set(signature, key)
      try { await api(`/api/${resource}${item.id ? `/${item.id}` : ''}`, item.id ? 'PATCH' : 'POST', data, resource === 'tasks' ? { 'Idempotency-Key': key } : undefined) }
      catch (err) {
        // The key is dropped only for an answer that is final (4xx). A dropped connection, a 5xx or a timeout may have saved it: the retry carries the same key.
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) keys.current.delete(signature)
        // A taken time: nothing was saved, the dialog stays as it is, and the conflict dialog says what is in the way.
        const taken = resource === 'tasks' ? parseConflict(err) : null
        if (taken) setConflict(taken)
        else setError(err instanceof ApiError && err.status === 422 && err.errors?.['schedule.ends_at'] ? pastMessage : (err as Error).message)
        return
      }
      keys.current.delete(signature)
      const removed = resource === 'tasks' && data.schedule === null && exec.opened.current
      const gone = removed ? { starts_at: removed.starts_at, ends_at: removed.ends_at } : null
      toast(gone ? t('Saved. Removed from the calendar.', 'تم الحفظ. أُزيلت من التقويم.', 'Opgeslagen. Uit de agenda gehaald.') : item.id ? t('Changes saved.', 'تم حفظ التغييرات.') : t('Created.', 'تم الإنشاء.'), 'success',
        gone ? { label: t('Undo', 'تراجع', 'Ongedaan maken'), onClick: () => restoreSession(gone) } : undefined)
      onSave()
      // The task lists, Today and the calendar read the server again (the calendar shows a task's session and free time), without polling.
      if (resource === 'tasks') window.dispatchEvent(new Event(TASKS_CHANGED))
      if (resource === 'tasks' || resource === 'events') window.dispatchEvent(new Event(CALENDAR_CHANGED))
      onClose()
    } finally { saving.current = false; setBusy(false) }
  }
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); void save() }

  const icon = (Icon: typeof Flame) => <Icon size={20} aria-hidden="true" />
  const priorityOptions: ChoiceOption[] = [{ value: 'urgent', label: label('urgent'), icon: icon(Flame), tone: 'urgent' }, { value: 'high', label: label('high'), icon: icon(ArrowUp), tone: 'high' }, { value: 'medium', label: label('medium'), icon: icon(Equal), tone: 'medium' }, { value: 'low', label: label('low'), icon: icon(ArrowDown), tone: 'low' }]
  const setSteps = (next: Step[]) => setSubtasks(next)
  const stepsEditor = (kindLabel: string, add: string, titleLabel: string): ReactNode => <fieldset className="full rf-steps"><legend>{kindLabel}</legend>
    {subtasks.map((s, i) => <div className="rf-step" key={i}><input aria-label={t('Completed', 'مكتمل')} type="checkbox" checked={s.completed} onChange={e => setSteps(subtasks.map((v, n) => n === i ? { ...v, completed: e.target.checked } : v))} /><input aria-label={titleLabel} value={s.title} required onChange={e => setSteps(subtasks.map((v, n) => n === i ? { ...v, title: e.target.value } : v))} /><button type="button" className="icon-button" aria-label={t('Remove', 'إزالة')} onClick={() => setSteps(subtasks.filter((_, n) => n !== i))}><X size={16} /></button></div>)}
    <button type="button" className="quiet" onClick={() => setSteps([...subtasks, { title: '', completed: false }])}><Plus size={16} aria-hidden="true" />{add}</button></fieldset>
  const asOptions = (list: RecordItem[]) => list.map(p => ({ id: p.id, title: p.title, color: typeof p.color === 'string' ? p.color : null }))
  const setPicked = (key: string) => (value: string) => setPick(p => ({ ...p, [key]: value }))

  const tasksFields = <>
    <ExecutionSection exec={exec} closed={closed} busy={busy} lateAfter={lateAfter} />
    <div className="field-block"><span className="field-title">{t('Priority', 'الأولوية')}</span><ChoiceGroup label={t('Priority', 'الأولوية')} variant="tiles" columns={4} name="priority" value={priority} onChange={setPriority} options={priorityOptions} /></div>
    <div className="field-block"><span className="field-title">{t('Status', 'الحالة')}</span><ChoiceGroup label={t('Status', 'الحالة')} name="status" value={status} onChange={setStatus} options={STATUSES.map(s => ({ value: s, label: label(s) }))} /></div>
    <div className="field-block"><span className="field-title">{t('Repeat', 'التكرار')}</span><ChoiceGroup label={t('Repeat', 'التكرار')} variant="tiles" columns={3} name="recurrence" value={recurrence} onChange={setRecurrence} options={[{ value: '', label: t('Does not repeat', 'بلا تكرار'), icon: icon(X) }, { value: 'daily', label: t('Daily', 'يومياً'), icon: icon(Repeat) }, { value: 'weekly', label: t('Weekly', 'أسبوعياً'), icon: icon(CalendarDays) }]} /></div>
    <div className="field-block rf-organize">
      <PickerField label={t('Project', 'المشروع')} name="project_id" icon={<FolderKanban size={18} />} value={pick.project_id} onChange={setPicked('project_id')} options={asOptions(projects.items)} loading={wantsLists && projects.loading} />
      <PickerField label={t('Goal', 'الهدف')} name="goal_id" icon={<Flag size={18} />} value={pick.goal_id} onChange={setPicked('goal_id')} options={asOptions(goals.items)} loading={wantsLists && goals.loading} />
      <PickerField label={t('Category', 'الفئة')} name="category_id" icon={<Tags size={18} />} value={pick.category_id} onChange={setPicked('category_id')} options={asOptions(categories.items)} loading={wantsLists && categories.loading} />
    </div>
    <details className="rf-more full" open={Boolean(item.description || item.notes || item.remind_at || openedDue.field || (item.tags as string[] | undefined)?.length || subtasks.length)}>
      <summary><ChevronDown size={16} aria-hidden="true" />{t('More options', 'خيارات متقدمة')}</summary>
      <div className="rf-more-body">
        <div className="field-block full rf-deadline-box">
          <label className="inline rf-notime"><input type="checkbox" checked={hasDeadline} aria-describedby={removing ? `${explainId} ${removeDueId}` : explainId} onChange={e => { setHasDeadline(e.target.checked); if (e.target.checked && !due) setDue(whenField('today', '')) }} />{t('Do you have a deadline for finishing it?', 'هل لديك موعد نهائي لإنجاز المهمة؟', 'Heb je een deadline om de taak af te ronden?')}</label>
          <small id={explainId} className="muted rf-explain"><span>{t('Execution time: when I will work on the task.', 'موعد التنفيذ: الوقت الذي سأعمل فيه على المهمة.', 'Uitvoeringstijd: wanneer ik aan de taak werk.')}</span> <span>{t('Deadline: the last moment I must have finished it by.', 'الموعد النهائي: آخر موعد يجب أن أنجزها قبله.', 'Deadline: het laatste moment waarop de taak klaar moet zijn.')}</span></small>
          {hasDeadline ? <>
            <div role="group" aria-label={t('Deadline (due)', 'الموعد النهائي (الاستحقاق)', 'Deadline (uiterste datum)')} aria-describedby={typedTimesShifted() ? `${helperId} ${zoneId}` : helperId}>
              <label className="rf-deadline">{t('Deadline (due)', 'الموعد النهائي (الاستحقاق)', 'Deadline (uiterste datum)')}{noTime
                ? <DateTimeField kind="date" name="due_date" value={due.slice(0, 10)} onChange={d => setDue(d ? `${d}T${due.slice(11, 16) || DEFAULT_DEADLINE_TIME}` : '')} />
                : <DateTimeField kind="datetime" name="due_at" value={due} onChange={setDue} />}</label>
              <label className="inline rf-notime"><input type="checkbox" checked={noTime} aria-describedby={helperId} onChange={e => setNoTime(e.target.checked)} />{t('No specific time', 'بدون وقت محدد', 'Geen vaste tijd')}</label></div>
            <ZoneNote id={zoneId} />
            <small id={helperId} className="muted" aria-live="polite">{noTime ? t('Due any time that day. It counts as overdue only after the day ends.', 'مستحقة في أي وقت من ذلك اليوم، وتُعدّ متأخرة بعد انتهاء اليوم فقط.', 'Op elk moment die dag. Pas te laat als de dag voorbij is.') : t('It counts as overdue after this time.', 'تُعدّ متأخرة بعد هذا الوقت.', 'Te laat na dit tijdstip.')}</small></>
          : removing ? <small id={removeDueId} className="muted">{t('Saving will remove the deadline.', 'سيؤدي الحفظ إلى حذف الموعد النهائي.', 'Opslaan verwijdert de deadline.')}</small> : null}
        </div>
        <label className="full">{t('Description', 'الوصف')}<textarea name="description" defaultValue={item.description || ''} rows={3} /></label>
        <label>{t('Remind me', 'ذكّرني')}<DateTimeField kind="datetime" name="remind_at" defaultValue={fieldOf(item.remind_at as string | null | undefined)} /></label>
        <label className="full">{t('Tags (comma separated)', 'الوسوم (مفصولة بفواصل)')}<input name="tags" defaultValue={(item.tags as string[] || []).join(', ')} autoCapitalize="none" /></label>
        <label className="full">{t('Notes', 'ملاحظات')}<textarea name="notes" defaultValue={String(item.notes || '')} /></label>
        {stepsEditor(t('Subtasks', 'المهام الفرعية'), t('Add subtask', 'إضافة مهمة فرعية'), t('Subtask title', 'عنوان المهمة الفرعية'))}
      </div>
    </details>
  </>

  const otherFields = <>
    <label className="full">{t('Description', 'الوصف')}<textarea name="description" defaultValue={item.description || ''} rows={3} /></label>
    {['projects', 'goals'].includes(resource) && <><label>{t('Deadline', 'الموعد النهائي')}<DateTimeField kind="datetime" name="due_at" defaultValue={fieldOf(item.due_at)} /></label><ZoneNote /></>}
    {(resource === 'projects' || resource === 'goals') && stepsEditor(t('Milestones', 'المراحل'), t('Add milestone', 'إضافة مرحلة'), t('Milestone title', 'عنوان المرحلة'))}
    {resource === 'projects' && <div className="field-block"><span className="field-title">{t('Status', 'الحالة')}</span><ChoiceGroup label={t('Status', 'الحالة')} name="status" value={status} onChange={setStatus} options={['active', 'paused', 'completed'].map(s => ({ value: s, label: label(s) }))} /></div>}
    {['projects', 'categories'].includes(resource) && <label>{t('Color', 'اللون')}<input type="color" name="color" defaultValue={item.color || '#6366f1'} /></label>}
    {resource === 'categories' && <div className="field-block"><span className="field-title">{t('Time boundary', 'الحدود الزمنية')}</span><ChoiceGroup label={t('Time boundary', 'الحدود الزمنية')} name="area" value={area} onChange={setArea} options={[{ value: '', label: t('Work (default)', 'العمل (افتراضي)') }, { value: 'study', label: t('Study', 'الدراسة') }, { value: 'personal', label: t('Personal', 'شخصي') }]} /></div>}
    {resource === 'goals' && <><label>{t('Target', 'القيمة المستهدفة')}<input type="number" name="target" inputMode="numeric" min="1" defaultValue={item.target || 100} /></label><label>{t('Progress', 'التقدم')}<input type="number" name="progress" inputMode="numeric" min="0" defaultValue={item.progress || 0} /></label></>}
    {resource === 'habits' && <>
      <div className="field-block"><span className="field-title">{t('Recurrence', 'التكرار')}</span><ChoiceGroup label={t('Recurrence', 'التكرار')} name="recurrence" value={recurrence} onChange={setRecurrence} options={[{ value: 'daily', label: t('Daily', 'يومي') }, { value: 'weekly', label: t('Weekly', 'أسبوعي') }]} /></div>
      <label>{t('Routine', 'الروتين')}<input name="routine" defaultValue={String(item.routine || '')} placeholder={t('Morning, evening…', 'صباحي، مسائي…')} /></label>
      <label>{t('Remind me at', 'ذكّرني الساعة')}<DateTimeField kind="time" name="remind_time" defaultValue={String(item.remind_time || '')} /><small className="muted">{t('Until it’s logged that day (week, for weekly habits).', 'حتى تُسجَّل ذلك اليوم (الأسبوع للعادات الأسبوعية).')}</small></label></>}
    {resource === 'events' && <>
      <label>{t('Start', 'البداية')}<DateTimeField kind="datetime" required name="starts_at" defaultValue={fieldOf(item.starts_at)} /></label>
      <label>{t('End', 'النهاية')}<DateTimeField kind="datetime" required name="ends_at" defaultValue={fieldOf(item.ends_at)} /></label>
      <ZoneNote />
      <div className="field-block"><span className="field-title">{t('Type', 'النوع')}</span><ChoiceGroup label={t('Type', 'النوع')} name="kind" value={kind} onChange={setKind} options={[{ value: 'fixed', label: t('Fixed commitment', 'موعد ثابت') }, { value: 'flexible', label: t('Flexible block', 'فترة مرنة') }]} /></div>
      {item.id && item.kind === 'fixed' && <label className="inline full confirm-fixed"><input type="checkbox" name="confirm_fixed" value="1" />{t('This is a fixed commitment. I confirm I want to change its time.', 'هذا التزام ثابت. أؤكد رغبتي في تغيير وقته.')}</label>}
      <PickerField label={t('Task', 'المهمة')} name="task_id" value={pick.task_id} onChange={setPicked('task_id')} options={asOptions(tasks.items)} loading={tasks.loading} /></>}
  </>

  return <BottomSheet tall title={item.id ? t('Edit item', 'تعديل العنصر') : t('Create item', 'إنشاء عنصر')} onClose={onClose} dirty={dirty} footer={<>
    <ErrorMessage error={error} />
    <SheetCancel>{t('Cancel', 'إلغاء')}</SheetCancel>
    <button type="submit" form={formId} className="primary" aria-disabled={busy || undefined} onClick={e => { if (busy) e.preventDefault() }}>{busy ? t('Saving…', 'جارٍ الحفظ…') : t('Save', 'حفظ')}</button></>}>
    <form id={formId} onSubmit={submit} className="form-grid record-form">
      <label className="full rf-title-field">{t('Title', 'العنوان')}<input data-autofocus name="title" className="rf-title" defaultValue={item.title} required maxLength={200} autoComplete="off" enterKeyHint="done" /></label>
      {resource === 'tasks' ? tasksFields : otherFields}
    </form>
    {conflict && <ScheduleConflictDialog key={conflict.requested.starts_at} conflict={conflict} onClose={() => setConflict(null)} onChoose={() => document.getElementById(exec.startId)?.focus()}
      onUseSuggestion={slot => { const field = deadlineField(slot.starts_at); setConflict(null); exec.fill(slot); void save({ day: field.slice(0, 10), start: field.slice(11, 16) }) }} />}
  </BottomSheet>
}
