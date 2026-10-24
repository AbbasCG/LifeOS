import { useEffect, useState, type FormEvent } from 'react'
import { Repeat, Trash2, AlertTriangle, Lock, ExternalLink } from 'lucide-react'
import { api, ApiError, type CalendarOccurrence, type RecordItem, type Recurrence } from '../lib/api'
import { localInput } from '../lib/hooks'
import { describeRecurrence } from '../lib/recurrence'
import { useText } from '../lib/i18n'
import { useLanguage } from '../contexts/LanguageContext'
import { useToast } from '../lib/toast'
import { Dialog, ErrorMessage } from '../components/ui/Shared'

type Draft = Partial<CalendarOccurrence> & { starts_at?: string; ends_at?: string }
type Scope = 'occurrence' | 'series'
const REMINDERS = [null, 0, 5, 10, 15, 30, 60, 120, 1440]

export default function EventForm({ item, tasks, onSaved, onClose }: { item: Draft; tasks: RecordItem[]; onSaved: () => void; onClose: () => void }) {
  const t = useText(), { language } = useLanguage(), toast = useToast()
  const isNew = !item.event_id, external = item.source && item.source !== 'lifeos'
  const [scope, setScope] = useState<Scope>(item.recurring ? 'occurrence' : 'series')
  const [title, setTitle] = useState(item.title ?? ''), [description, setDescription] = useState(item.description ?? '')
  const [start, setStart] = useState(localInput(item.starts_at)), [end, setEnd] = useState(localInput(item.ends_at))
  const [kind, setKind] = useState(item.kind ?? 'fixed'), [taskId, setTaskId] = useState(item.task_id ? String(item.task_id) : ''), [remind, setRemind] = useState<string>(item.remind_minutes == null ? '' : String(item.remind_minutes))
  const [rule, setRule] = useState<Recurrence | null>(item.recurrence ?? null)
  const [endMode, setEndMode] = useState<'never' | 'until' | 'count'>(item.recurrence?.until ? 'until' : item.recurrence?.count ? 'count' : 'never')
  const [confirmFixed, setConfirmFixed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflicts, setConflicts] = useState('')
  const [series, setSeries] = useState<{ starts_at: string; ends_at: string } | null>(null)

  useEffect(() => {
    if (!item.recurring || !item.event_id) return
    let active = true
    api<{ data: { starts_at: string; ends_at: string } }>(`/api/events/${item.event_id}`).then(r => { if (active) setSeries(r.data) }).catch(() => {})
    return () => { active = false }
  }, [item.recurring, item.event_id])

  if (external) return <Dialog title={item.title || t('External event', 'موعد خارجي')} onClose={onClose}>
    <p className="muted"><ExternalLink size={14} /> {t(`Synced read-only from ${item.source === 'google' ? 'Google Calendar' : 'Outlook'}${item.account_label ? ` (${item.account_label})` : ''}. Edit it in that calendar.`, `متزامن للقراءة فقط من ${item.source === 'google' ? 'تقويم Google' : 'Outlook'}. عدّله في ذلك التقويم.`)}</p>
    <p><strong>{new Date(item.starts_at!).toLocaleString(language, { dateStyle: 'full', timeStyle: 'short' })}</strong> – {new Date(item.ends_at!).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })}</p>
    {item.description && <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{item.description}</p>}
  </Dialog>

  const editingSeries = !isNew && item.recurring && scope === 'series'
  const showRule = isNew || !item.recurring || scope === 'series'
  const timesChanged = !isNew && (new Date(start).getTime() !== new Date(item.starts_at!).getTime() || new Date(end).getTime() !== new Date(item.ends_at!).getTime())
  const fixedLocked = !isNew && item.kind === 'fixed' && kind === 'fixed' && timesChanged

  function payload(ignoreConflicts: boolean) {
    let s = new Date(start), e = new Date(end)
    if (editingSeries && series && item.occurrence_start) {
      // Apply the change made to this occurrence to the whole series by the same offset.
      const shiftStart = s.getTime() - new Date(item.starts_at!).getTime(), shiftEnd = e.getTime() - new Date(item.ends_at!).getTime()
      s = new Date(new Date(series.starts_at).getTime() + shiftStart); e = new Date(new Date(series.ends_at).getTime() + shiftEnd)
    }
    const body: Record<string, unknown> = { title, description: description || null, kind, starts_at: s.toISOString(), ends_at: e.toISOString(), task_id: taskId ? Number(taskId) : null, remind_minutes: remind === '' ? null : Number(remind) }
    if (showRule) body.recurrence = rule ? { ...rule, count: endMode === 'count' ? rule.count ?? 10 : undefined, until: endMode === 'until' ? rule.until : undefined } : null
    if (!isNew && item.recurring && scope === 'occurrence') { body.scope = 'occurrence'; body.occurrence_start = item.occurrence_start; delete body.task_id; delete body.remind_minutes }
    if (confirmFixed) body.confirm_fixed = true
    if (ignoreConflicts) body.ignore_conflicts = true
    if (isNew) body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return body
  }
  async function submit(e: FormEvent | null, ignoreConflicts = false) {
    e?.preventDefault(); setBusy(true); setError(''); setConflicts('')
    try {
      await api(isNew ? '/api/events' : `/api/events/${item.event_id}`, isNew ? 'POST' : 'PATCH', payload(ignoreConflicts))
      toast(isNew ? t('Event created.', 'تم إنشاء الموعد.') : scope === 'occurrence' && item.recurring ? t('This occurrence was updated.', 'تم تحديث هذا الموعد فقط.') : t('Event updated.', 'تم تحديث الموعد.'))
      onSaved(); onClose()
    } catch (err) {
      if (err instanceof ApiError && err.errors.recurrence_conflicts) setConflicts(err.errors.recurrence_conflicts[0])
      else setError((err as Error).message)
    } finally { setBusy(false) }
  }
  async function remove(which: Scope) {
    setBusy(true); setError('')
    try {
      await api(`/api/events/${item.event_id}${which === 'occurrence' ? `?scope=occurrence&occurrence_start=${encodeURIComponent(item.occurrence_start!)}` : ''}`, 'DELETE')
      toast(which === 'occurrence' ? t('This occurrence was removed.', 'حُذف هذا الموعد فقط.') : item.recurring ? t('The whole series was deleted.', 'حُذفت السلسلة كاملة.') : t('Event deleted.', 'تم حذف الموعد.'))
      onSaved(); onClose()
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  const setFreq = (freq: string) => setRule(freq ? { freq: freq as Recurrence['freq'], interval: rule?.interval ?? 1, by_weekday: freq === 'weekly' ? rule?.by_weekday ?? [new Date(start || Date.now()).getDay()] : undefined, count: rule?.count, until: rule?.until } : null)

  return <Dialog title={isNew ? t('New event', 'موعد جديد') : t('Edit event', 'تعديل الموعد')} onClose={onClose}>
    <form className="form-grid event-form" onSubmit={e => void submit(e)}>
      <ErrorMessage error={error} />
      {!isNew && item.recurring && <fieldset className="full scope-picker"><legend><Repeat size={14} /> {t('This event repeats', 'هذا موعد متكرر')} · {describeRecurrence(item.recurrence, language, t)}</legend>
        <div className="segmented" role="radiogroup" aria-label={t('Apply changes to', 'تطبيق التغييرات على')}>
          <button type="button" role="radio" aria-checked={scope === 'occurrence'} className={scope === 'occurrence' ? 'active' : ''} onClick={() => setScope('occurrence')}>{t('This event only', 'هذا الموعد فقط')}</button>
          <button type="button" role="radio" aria-checked={scope === 'series'} className={scope === 'series' ? 'active' : ''} onClick={() => setScope('series')}>{t('All events in the series', 'كل مواعيد السلسلة')}</button>
        </div>
      </fieldset>}
      <label className="full">{t('Title', 'العنوان')}<input autoFocus required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>{t('Start', 'البداية')}<input type="datetime-local" required value={start} onChange={e => setStart(e.target.value)} /></label>
      <label>{t('End', 'النهاية')}<input type="datetime-local" required value={end} onChange={e => setEnd(e.target.value)} /></label>
      <label>{t('Type', 'النوع')}<select value={kind} onChange={e => setKind(e.target.value)}><option value="fixed">{t('Fixed commitment', 'موعد ثابت')}</option><option value="flexible">{t('Flexible block', 'فترة مرنة')}</option></select></label>
      {!(item.recurring && scope === 'occurrence') && <label>{t('Reminder', 'التذكير')}<select value={remind} onChange={e => setRemind(e.target.value)}>{REMINDERS.map(m => <option key={String(m)} value={m == null ? '' : m}>{m == null ? t('Default', 'افتراضي') : m === 0 ? t('At start time', 'عند البداية') : m >= 60 ? t(`${m / 60} h before`, `قبل ${m / 60} س`) : t(`${m} min before`, `قبل ${m} د`)}</option>)}</select></label>}
      {!(item.recurring && scope === 'occurrence') && <label className="full">{t('Linked task', 'مهمة مرتبطة')}<select value={taskId} onChange={e => setTaskId(e.target.value)}><option value="">—</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>}
      {showRule && <fieldset className="full recurrence-builder">
        <legend><Repeat size={14} /> {t('Repeat', 'التكرار')}</legend>
        <div className="form-grid">
          <label>{t('Frequency', 'التكرار')}<select value={rule?.freq ?? ''} onChange={e => setFreq(e.target.value)}><option value="">{t('Does not repeat', 'لا يتكرر')}</option><option value="daily">{t('Daily', 'يومي')}</option><option value="weekly">{t('Weekly', 'أسبوعي')}</option><option value="monthly">{t('Monthly', 'شهري')}</option><option value="yearly">{t('Yearly', 'سنوي')}</option></select></label>
          {rule && <label>{t('Every', 'كل')}<input type="number" min={1} max={365} value={rule.interval ?? 1} onChange={e => setRule({ ...rule, interval: Math.max(1, Number(e.target.value)) })} /></label>}
          {rule?.freq === 'weekly' && <div className="full weekday-toggle" role="group" aria-label={t('Repeat on', 'التكرار في')}>{[1, 2, 3, 4, 5, 6, 0].map(d => { const on = rule.by_weekday?.includes(d); return <button key={d} type="button" aria-pressed={on} className={on ? 'on' : ''} onClick={() => { const next = on ? (rule.by_weekday ?? []).filter(x => x !== d) : [...(rule.by_weekday ?? []), d]; if (next.length) setRule({ ...rule, by_weekday: next }) }}>{new Date(2026, 0, 4 + d).toLocaleDateString(language, { weekday: 'narrow' })}</button> })}</div>}
          {rule && <label>{t('Ends', 'ينتهي')}<select value={endMode} onChange={e => setEndMode(e.target.value as typeof endMode)}><option value="never">{t('Never', 'أبداً')}</option><option value="until">{t('On a date', 'في تاريخ')}</option><option value="count">{t('After a number of times', 'بعد عدد مرات')}</option></select></label>}
          {rule && endMode === 'until' && <label>{t('Last date', 'آخر تاريخ')}<input type="date" required value={rule.until ?? ''} min={start.slice(0, 10)} onChange={e => setRule({ ...rule, until: e.target.value })} /></label>}
          {rule && endMode === 'count' && <label>{t('Occurrences', 'عدد المرات')}<input type="number" min={1} max={1000} required value={rule.count ?? 10} onChange={e => setRule({ ...rule, count: Number(e.target.value) })} /></label>}
        </div>
        {rule && <p className="muted rule-summary">{describeRecurrence({ ...rule, count: endMode === 'count' ? rule.count ?? 10 : undefined, until: endMode === 'until' ? rule.until : undefined }, language, t)}</p>}
      </fieldset>}
      <label className="full">{t('Notes', 'ملاحظات')}<textarea rows={2} value={description} onChange={e => setDescription(e.target.value)} /></label>
      {fixedLocked && <label className="inline full confirm-fixed"><input type="checkbox" checked={confirmFixed} onChange={e => setConfirmFixed(e.target.checked)} /><Lock size={14} />{t('This is a fixed commitment. I confirm I want to change its time.', 'هذا التزام ثابت. أؤكد رغبتي في تغيير وقته.')}</label>}
      {conflicts && <div className="full banner warning" role="alert"><AlertTriangle size={18} /><p>{conflicts}</p><button type="button" className="quiet" disabled={busy} onClick={() => void submit(null, true)}>{t('Save anyway', 'احفظ على أي حال')}</button></div>}
      <footer className="full row event-actions">
        {!isNew && <span className="toolbar">{item.recurring ? <><button type="button" className="danger" disabled={busy} onClick={() => void remove('occurrence')}><Trash2 size={15} />{t('Delete this event', 'حذف هذا الموعد')}</button><button type="button" className="quiet" disabled={busy} onClick={() => void remove('series')}>{t('Delete series', 'حذف السلسلة')}</button></> : <button type="button" className="danger" disabled={busy} onClick={() => void remove('series')}><Trash2 size={15} />{t('Delete', 'حذف')}</button>}</span>}
        <span className="toolbar"><button type="button" className="quiet" onClick={onClose}>{t('Cancel', 'إلغاء')}</button><button className="primary" disabled={busy || (fixedLocked && !confirmFixed)}>{busy ? t('Saving…', 'جارٍ الحفظ…') : t('Save', 'حفظ')}</button></span>
      </footer>
    </form>
  </Dialog>
}
