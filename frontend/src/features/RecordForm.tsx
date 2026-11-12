import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, CalendarDays, CalendarX, ChevronDown, Equal, Flag, Flame, FolderKanban, Plus, Repeat, Sun, Sunrise, Tags, X } from 'lucide-react'
import { api, type RecordItem } from '../lib/api'
import { useRecords } from '../lib/hooks'
import { accountDay } from '../lib/accountDay'
import { DEFAULT_DEADLINE_TIME, TASKS_CHANGED, deadlineField, deadlineInstant, deriveWhen, whenField, type When } from '../lib/quickAdd'
import { CALENDAR_CHANGED } from '../lib/taskSchedule'
import { TaskSessionBlock } from './tasks/TaskSessionBlock'
import { DateTimeField } from '../components/ui/DateTimePicker'
import { ChoiceGroup, PickerField, type ChoiceOption } from '../components/ui/Choice'
import { BottomSheet, SheetCancel } from '../components/visual'
import { ErrorMessage } from '../components/ui/Shared'
import { useText } from '../lib/i18n'
import { useLanguage } from '../contexts/LanguageContext'
import { useToast } from '../lib/toast'

const NL: Record<string, string> = {"Active": "Actief", "Add milestone": "Mijlpaal toevoegen", "Add subtask": "Subtaak toevoegen", "Cancel": "Annuleren", "Cancelled": "Geannuleerd", "Category": "Categorie", "Changes saved.": "Wijzigingen opgeslagen.", "Color": "Kleur", "Completed": "Voltooid", "Create item": "Item maken", "Created.": "Gemaakt.", "Daily": "Dagelijks", "Deadline": "Deadline", "Description": "Beschrijving", "Does not repeat": "Herhaalt niet", "Duration": "Duur", "Edit item": "Item bewerken", "End": "Einde", "Estimate (minutes)": "Geschatte duur (minuten)", "Fixed commitment": "Vaste afspraak", "Flexible block": "Flexibel blok", "Goal": "Doel", "High": "Hoog", "In progress": "Bezig", "Inbox": "Inbox", "Low": "Laag", "Medium": "Gemiddeld", "Milestone title": "Titel van mijlpaal", "Milestones": "Mijlpalen", "More options": "Meer opties", "Morning, evening…": "Ochtend, avond…", "No date": "Geen datum", "Notes": "Notities", "Paused": "Gepauzeerd", "Personal": "Persoonlijk", "Priority": "Prioriteit", "Progress": "Voortgang", "Project": "Project", "Recurrence": "Herhaling", "Remind me": "Herinner mij", "Remind me at": "Herinner mij om", "Remove": "Verwijderen", "Repeat": "Herhalen", "Routine": "Routine", "Save": "Opslaan", "Saving…": "Opslaan…", "Start": "Start", "Status": "Status", "Study": "Studie", "Subtask title": "Titel van subtaak", "Subtasks": "Subtaken", "Tags (comma separated)": "Labels (komma-gescheiden)", "Target": "Streefwaarde", "Task": "Taak", "This is a fixed commitment. I confirm I want to change its time.": "Dit is een vaste afspraak. Ik bevestig dat ik de tijd wil wijzigen.", "This week": "Deze week", "Time boundary": "Tijdsgrens", "Title": "Titel", "To do": "Te doen", "Today": "Vandaag", "Tomorrow": "Morgen", "Type": "Type", "Until it’s logged that day (week, for weekly habits).": "Tot het die dag is vastgelegd (week, bij wekelijkse gewoonten).", "Urgent": "Urgent", "Weekly": "Wekelijks", "When": "Wanneer", "Work (default)": "Werk (standaard)", "h": "u", "m": "m"}
/** `t` for this dialog: the usual three-language text, with Dutch for every English phrase listed above (others pass their own). */
function useT() { const base = useText(); return (en: string, ar: string, nl?: string) => base(en, ar, nl ?? NL[en]) }
const STATUSES = ['inbox', 'todo', 'in_progress', 'completed', 'cancelled']
export function useStatusLabel() { const t = useT(); return (s: string) => ({ inbox: t('Inbox', 'الوارد'), todo: t('To do', 'للإنجاز'), in_progress: t('In progress', 'قيد التنفيذ'), completed: t('Completed', 'مكتمل'), cancelled: t('Cancelled', 'ملغى'), low: t('Low', 'منخفضة'), medium: t('Medium', 'متوسطة'), high: t('High', 'عالية'), urgent: t('Urgent', 'عاجلة'), active: t('Active', 'نشط'), paused: t('Paused', 'متوقف') }[s] || s) }

const MINUTES = [15, 30, 45, 60, 90, 120]
/** A saved instant as the date fields show it: the browser's wall clock ('' for none), exactly as before; posted back as that wall time's instant. */
const fieldOf = deadlineField
/** 'Wednesday 11 November' for a 'YYYY-MM-DD' day: a calendar date, so no timezone shifts it. */
const dayText = (day: string, language: string, thisYear = accountDay().slice(0, 4)) => new Intl.DateTimeFormat(language === 'ar' ? 'ar-u-nu-latn' : language === 'nl' ? 'nl-NL' : 'en', { weekday: 'long', day: 'numeric', month: 'long', ...(day.slice(0, 4) !== thisYear ? { year: 'numeric' as const } : {}), timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`))
type Step = { title: string; completed: boolean }

/**
 * Create / edit any item (task, project, goal, habit, category, event) in a bottom sheet on phones and a centred card elsewhere.
 * The Save button lives in the sheet's footer, so it is never scrolled out of sight. Short lists of options are one-tap choices (no
 * drop-downs); long lists (project, goal, category, task) are a searchable picker; rarely used fields sit under "More options".
 * The posted data is the same as the old form's, field for field.
 */
export function RecordForm({ resource, item, onSave, onClose }: { resource: string; item: Partial<RecordItem>; onSave: () => void; onClose: () => void }) {
  const t = useT(), label = useStatusLabel(), toast = useToast(), { language } = useLanguage()
  const saving = useRef(false), helperId = useId()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const wantsLists = resource === 'tasks', projects = useRecords('projects'), categories = useRecords('categories'), goals = useRecords('goals'), tasks = useRecords('tasks')
  const [subtasks, setSubtasks] = useState<Step[]>((((resource === 'projects' || resource === 'goals') ? item.milestones : item.subtasks) as Step[]) || [])
  // Controlled values that the choice buttons set (each is also posted through a hidden input of the same name).
  const [status, setStatus] = useState(String(item.status || (resource === 'projects' ? 'active' : 'inbox')))
  const [priority, setPriority] = useState(String(item.priority || 'medium'))
  const [minutes, setMinutes] = useState(String(item.estimated_minutes || 30))
  const [recurrence, setRecurrence] = useState(String(item.recurrence || (resource === 'habits' ? 'daily' : '')))
  const [due, setDue] = useState(fieldOf(item.due_at))
  // The tile just tapped and the field it produced: "This week" on a Saturday or Sunday lands on tomorrow or today, and the tile that was tapped stays the one checked until the field changes.
  const [lastTile, setLastTile] = useState<{ tile: string; field: string } | null>(null)
  const [customNote, setCustomNote] = useState('')
  const [pick, setPick] = useState<Record<string, string>>({ project_id: String(item.project_id || ''), goal_id: String(item.goal_id || ''), category_id: String(item.category_id || ''), task_id: String(item.task_id || '') })
  const [kind, setKind] = useState(String(item.kind || 'fixed')), [area, setArea] = useState(String(item.area || ''))
  const formId = `record-form-${resource}`
  // Unsaved work = any posted field or subtask that differs from what the form opened with (hidden inputs carry the choice buttons' values).
  const opened = useRef<string | null>(null)
  const snapshot = useCallback(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null
    return form ? JSON.stringify([[...new FormData(form)].map(([k, v]) => [k, String(v)]), subtasks]) : null
  }, [formId, subtasks])
  useEffect(() => { opened.current ??= snapshot() })
  const dirty = useCallback(() => { const now = snapshot(); return opened.current !== null && now !== null && now !== opened.current }, [snapshot])

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (saving.current) return   // a second click or Enter while the first save is still running sends nothing
    saving.current = true; setBusy(true); setError('')
    const data: Record<string, unknown> = Object.fromEntries(new FormData(e.currentTarget))
    for (const key of ['due_at', 'remind_at', 'starts_at', 'ends_at']) if (key in data) data[key] = data[key] ? deadlineInstant(String(data[key])) : null
    for (const key of ['project_id', 'goal_id', 'category_id', 'task_id']) if (key in data) data[key] = data[key] ? Number(data[key]) : null
    if (resource === 'tasks') { data.subtasks = subtasks; data.tags = String(data.tags || '').split(',').map(s => s.trim()).filter(Boolean); data.recurrence = data.recurrence || null }
    if (resource === 'projects' || resource === 'goals') data.milestones = subtasks
    try { await api(`/api/${resource}${item.id ? `/${item.id}` : ''}`, item.id ? 'PATCH' : 'POST', data); toast(item.id ? t('Changes saved.', 'تم حفظ التغييرات.') : t('Created.', 'تم الإنشاء.')); onSave()
      // The task lists, Today and the calendar read the server again (the calendar shows a task's session and free time), without polling.
      if (resource === 'tasks') window.dispatchEvent(new Event(TASKS_CHANGED))
      if (resource === 'tasks' || resource === 'events') window.dispatchEvent(new Event(CALENDAR_CHANGED))
      onClose() }
    catch (err) { setError((err as Error).message) } finally { saving.current = false; setBusy(false) }
  }

  const icon = (Icon: typeof Sun) => <Icon size={20} aria-hidden="true" />
  const whenOptions: ChoiceOption<string>[] = [{ value: 'today', label: t('Today', 'اليوم'), icon: icon(Sun) }, { value: 'tomorrow', label: t('Tomorrow', 'غدًا'), icon: icon(Sunrise) }, { value: 'week', label: t('This week', 'هذا الأسبوع'), icon: icon(CalendarDays) }, { value: 'none', label: t('No date', 'بلا موعد'), icon: icon(CalendarX) }]
  // The selected tile is read from the deadline itself, on the account's calendar; a day no tile means selects none and is named below.
  const derived = deriveWhen(due), kept = lastTile && lastTile.field === due && derived !== 'custom' && derived !== 'none' ? lastTile.tile : null
  const chosenWhen = kept ?? (derived === 'custom' ? '' : derived)
  const customText = derived === 'custom' ? `${t('Custom due date', 'موعد مخصص', 'Aangepaste deadline')}: ${dayText(due.slice(0, 10), language)}` : ''
  // The screen-reader copy of the custom-date line is a status that is always there and is filled a moment after the date stops changing, so a picker being scrolled does not announce every day.
  useEffect(() => {
    if (!customText) return
    const id = window.setTimeout(() => setCustomNote(customText), 600)
    return () => window.clearTimeout(id)
  }, [customText])
  const priorityOptions: ChoiceOption[] = [{ value: 'urgent', label: label('urgent'), icon: icon(Flame), tone: 'urgent' }, { value: 'high', label: label('high'), icon: icon(ArrowUp), tone: 'high' }, { value: 'medium', label: label('medium'), icon: icon(Equal), tone: 'medium' }, { value: 'low', label: label('low'), icon: icon(ArrowDown), tone: 'low' }]
  const setSteps = (next: Step[]) => setSubtasks(next)
  const stepsEditor = (kindLabel: string, add: string, titleLabel: string): ReactNode => <fieldset className="full rf-steps"><legend>{kindLabel}</legend>
    {subtasks.map((s, i) => <div className="rf-step" key={i}><input aria-label={t('Completed', 'مكتمل')} type="checkbox" checked={s.completed} onChange={e => setSteps(subtasks.map((v, n) => n === i ? { ...v, completed: e.target.checked } : v))} /><input aria-label={titleLabel} value={s.title} required onChange={e => setSteps(subtasks.map((v, n) => n === i ? { ...v, title: e.target.value } : v))} /><button type="button" className="icon-button" aria-label={t('Remove', 'إزالة')} onClick={() => setSteps(subtasks.filter((_, n) => n !== i))}><X size={16} /></button></div>)}
    <button type="button" className="quiet" onClick={() => setSteps([...subtasks, { title: '', completed: false }])}><Plus size={16} aria-hidden="true" />{add}</button></fieldset>
  const asOptions = (list: RecordItem[]) => list.map(p => ({ id: p.id, title: p.title, color: typeof p.color === 'string' ? p.color : null }))
  const setPicked = (key: string) => (value: string) => setPick(p => ({ ...p, [key]: value }))

  const tasksFields = <>
    <div className="field-block"><span className="field-title">{t('When', 'متى')}</span>
      <ChoiceGroup<string> label={t('When', 'متى')} variant="tiles" columns={4} value={chosenWhen} onChange={w => { const next = whenField(w as When, due); setDue(next); setLastTile(w === 'none' ? null : { tile: w, field: next }) }} options={whenOptions} />
      <div role="group" aria-label={t('Deadline (due)', 'الموعد النهائي (الاستحقاق)', 'Deadline (uiterste datum)')} aria-describedby={helperId}>
        <label className="rf-deadline">{t('Deadline (due)', 'الموعد النهائي (الاستحقاق)', 'Deadline (uiterste datum)')}<DateTimeField kind="datetime" name="due_at" value={due} onChange={setDue} /></label></div>
      <small className="rf-custom" aria-hidden="true">{customText}</small>
      <span className="sr-only" role="status">{customText && customNote === customText ? customNote : ''}</span>
      <small id={helperId} className="muted">{t(`Choosing a day keeps the time; with no time yet it starts at ${DEFAULT_DEADLINE_TIME} (or the next half hour if that has passed today).`, `اختيار اليوم يُبقي الوقت كما هو؛ وإن لم يكن هناك وقت يبدأ عند ${DEFAULT_DEADLINE_TIME} (أو أقرب نصف ساعة إن كانت الساعة 17:00 قد مضت اليوم).`, `Een dag kiezen behoudt de tijd; zonder tijd begint het om ${DEFAULT_DEADLINE_TIME} (of het volgende halve uur als dat vandaag voorbij is).`)}</small></div>
    {item.id && <TaskSessionBlock task={item as RecordItem} due={due} />}
    <div className="field-block"><span className="field-title">{t('Priority', 'الأولوية')}</span><ChoiceGroup label={t('Priority', 'الأولوية')} variant="tiles" columns={4} name="priority" value={priority} onChange={setPriority} options={priorityOptions} /></div>
    <div className="field-block"><span className="field-title">{t('Status', 'الحالة')}</span><ChoiceGroup label={t('Status', 'الحالة')} name="status" value={status} onChange={setStatus} options={STATUSES.map(s => ({ value: s, label: label(s) }))} /></div>
    <div className="field-block"><span className="field-title">{t('Estimate (minutes)', 'المدة المقدرة (دقائق)')}</span>
      <ChoiceGroup label={t('Duration', 'المدة')} value={MINUTES.map(String).includes(minutes) ? minutes : ''} onChange={setMinutes} options={MINUTES.map(m => ({ value: String(m), label: m >= 60 && m % 60 === 0 ? `${m / 60}${t('h', 'س')}` : `${m}${t('m', 'د')}` }))} />
      <input type="number" name="estimated_minutes" inputMode="numeric" min="5" max="10080" value={minutes} aria-label={t('Estimate (minutes)', 'المدة المقدرة (دقائق)')} onChange={e => setMinutes(e.target.value)} /></div>
    <div className="field-block"><span className="field-title">{t('Repeat', 'التكرار')}</span><ChoiceGroup label={t('Repeat', 'التكرار')} variant="tiles" columns={3} name="recurrence" value={recurrence} onChange={setRecurrence} options={[{ value: '', label: t('Does not repeat', 'بلا تكرار'), icon: icon(X) }, { value: 'daily', label: t('Daily', 'يومياً'), icon: icon(Repeat) }, { value: 'weekly', label: t('Weekly', 'أسبوعياً'), icon: icon(CalendarDays) }]} /></div>
    <div className="field-block rf-organize">
      <PickerField label={t('Project', 'المشروع')} name="project_id" icon={<FolderKanban size={18} />} value={pick.project_id} onChange={setPicked('project_id')} options={asOptions(projects.items)} loading={wantsLists && projects.loading} />
      <PickerField label={t('Goal', 'الهدف')} name="goal_id" icon={<Flag size={18} />} value={pick.goal_id} onChange={setPicked('goal_id')} options={asOptions(goals.items)} loading={wantsLists && goals.loading} />
      <PickerField label={t('Category', 'الفئة')} name="category_id" icon={<Tags size={18} />} value={pick.category_id} onChange={setPicked('category_id')} options={asOptions(categories.items)} loading={wantsLists && categories.loading} />
    </div>
    <details className="rf-more full" open={Boolean(item.description || item.notes || item.remind_at || (item.tags as string[] | undefined)?.length || subtasks.length)}>
      <summary><ChevronDown size={16} aria-hidden="true" />{t('More options', 'خيارات إضافية')}</summary>
      <div className="rf-more-body">
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
    {['projects', 'goals'].includes(resource) && <label>{t('Deadline', 'الموعد النهائي')}<DateTimeField kind="datetime" name="due_at" defaultValue={fieldOf(item.due_at)} /></label>}
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
      <div className="field-block"><span className="field-title">{t('Type', 'النوع')}</span><ChoiceGroup label={t('Type', 'النوع')} name="kind" value={kind} onChange={setKind} options={[{ value: 'fixed', label: t('Fixed commitment', 'موعد ثابت') }, { value: 'flexible', label: t('Flexible block', 'فترة مرنة') }]} /></div>
      {item.id && item.kind === 'fixed' && <label className="inline full confirm-fixed"><input type="checkbox" name="confirm_fixed" value="1" />{t('This is a fixed commitment. I confirm I want to change its time.', 'هذا التزام ثابت. أؤكد رغبتي في تغيير وقته.')}</label>}
      <PickerField label={t('Task', 'المهمة')} name="task_id" value={pick.task_id} onChange={setPicked('task_id')} options={asOptions(tasks.items)} loading={tasks.loading} /></>}
  </>

  return <BottomSheet tall title={item.id ? t('Edit item', 'تعديل العنصر') : t('Create item', 'إنشاء عنصر')} onClose={onClose} dirty={dirty} footer={<>
    <ErrorMessage error={error} />
    <SheetCancel>{t('Cancel', 'إلغاء')}</SheetCancel>
    <button type="submit" form={formId} className="primary" aria-disabled={busy || undefined} onClick={e => { if (busy) e.preventDefault() }}>{busy ? t('Saving…', 'جارٍ الحفظ…') : t('Save', 'حفظ')}</button></>}>
    <form id={formId} onSubmit={e => void submit(e)} className="form-grid record-form">
      <label className="full rf-title-field">{t('Title', 'العنوان')}<input data-autofocus name="title" className="rf-title" defaultValue={item.title} required maxLength={200} autoComplete="off" enterKeyHint="done" /></label>
      {resource === 'tasks' ? tasksFields : otherFields}
    </form>
  </BottomSheet>
}
