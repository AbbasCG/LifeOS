import { useState, type FormEvent } from 'react'
import { Workflow, Plus, Trash2, Pencil, History, Eye, Zap, AlertTriangle, ArrowRight } from 'lucide-react'
import { api } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { Dialog, ErrorMessage, Skeleton } from '../../components/ui/Shared'

type Conditions = { min_priority?: string; overdue_hours?: number; min_minutes?: number; grace_hours?: number; threshold?: number; days_ahead?: number }
type Rule = { id: number; name: string; trigger: string; action: string; conditions: Conditions; action_config: { message?: string }; enabled: boolean; run_count: number; last_run_at: string | null; failed_runs?: number }
type Template = { key: string; trigger: string; action: string; conditions: Conditions; en: string; ar: string }
type Payload = { rules: Rule[]; catalogue: Record<string, string[]>; templates: Template[]; limit: number }
type Run = { id: number; status: 'succeeded' | 'skipped' | 'failed' | 'running'; subject: string | null; message: string | null; error: string | null; attempts: number; created_at: string }
type Draft = Omit<Rule, 'id' | 'run_count' | 'last_run_at' | 'enabled'> & { id?: number }

const DEFAULTS: Record<string, Conditions> = { task_overdue: { min_priority: 'medium', overdue_hours: 2 }, focus_completed: { min_minutes: 10 }, recurring_task_due: { grace_hours: 12 }, weekly_review_completed: {}, day_overloaded: { threshold: 90, days_ahead: 2 } }

function useAutomationLabels() {
  const t = useText()
  const triggers: Record<string, string> = { task_overdue: t('A task becomes overdue', 'تتأخر مهمة'), focus_completed: t('A focus session ends', 'تنتهي جلسة تركيز'), recurring_task_due: t('A recurring task is due', 'يحين موعد مهمة متكررة'), weekly_review_completed: t('I complete my weekly review', 'أُكمل مراجعتي الأسبوعية'), day_overloaded: t('A day is overloaded', 'يكون اليوم مزدحماً') }
  const actions: Record<string, string> = { suggest_time_block: t('Suggest a time block', 'اقترح وقتاً في التقويم'), update_focus_stats: t('Update task progress & focus stats', 'حدّث تقدم المهمة وإحصاءات التركيز'), create_next_occurrence: t('Create the next occurrence', 'أنشئ التكرار التالي'), offer_next_week_plan: t('Offer next week’s plan', 'اعرض خطة الأسبوع القادم'), suggest_rebalance: t('Suggest rescheduling flexible tasks', 'اقترح إعادة جدولة المهام المرنة'), notify: t('Send me a notification', 'أرسل لي إشعاراً') }
  return { triggers, actions }
}

export default function AutomationSettings() {
  const t = useText(), { language } = useLanguage(), toast = useToast(), { triggers, actions } = useAutomationLabels()
  const { data, error, reload } = useApi<Payload>('/api/automations')
  const [draft, setDraft] = useState<Draft | null>(null), [logFor, setLogFor] = useState<Rule | null>(null), [busy, setBusy] = useState(''), [failure, setFailure] = useState('')
  const when = (iso: string) => new Date(iso).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })

  async function run(key: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(key); setFailure('')
    try { await fn(); if (success) toast(success); reload() } catch (e) { setFailure((e as Error).message) } finally { setBusy('') }
  }
  const toggle = (r: Rule) => run(`toggle-${r.id}`, () => api(`/api/automations/${r.id}`, 'PATCH', { enabled: !r.enabled }), r.enabled ? t('Automation paused.', 'أُوقفت الأتمتة.') : t('Automation on.', 'فُعّلت الأتمتة.'))
  const remove = (r: Rule) => run(`delete-${r.id}`, () => api(`/api/automations/${r.id}`, 'DELETE'), t('Automation deleted.', 'حُذفت الأتمتة.'))
  const addTemplate = (tpl: Template) => run(`tpl-${tpl.key}`, () => api('/api/automations', 'POST', { name: language === 'ar' ? tpl.ar : tpl.en, trigger: tpl.trigger, action: tpl.action, conditions: tpl.conditions }), t('Automation added.', 'أُضيفت الأتمتة.'))

  if (error) return <ErrorMessage error={error} />
  if (!data) return <Skeleton lines={5} />
  const used = new Set(data.rules.map(r => `${r.trigger}:${r.action}`))
  const available = data.templates.filter(tpl => !used.has(`${tpl.trigger}:${tpl.action}`))
  return <div className="settings-stack">
    <section className="panel reveal integration-intro">
      <Workflow size={22} />
      <div><h2>{t('Automations', 'الأتمتة')}</h2><p className="muted">{t('Let LifeOS handle routine follow-ups. Automations only use your own data, run once per event, and anything that changes your calendar is offered as a suggestion for you to approve.', 'دع LifeOS يتولى المتابعات الروتينية. تستخدم الأتمتة بياناتك فقط، وتعمل مرة واحدة لكل حدث، وأي تغيير على تقويمك يُعرض كاقتراح بانتظار موافقتك.')}</p></div>
    </section>

    {available.length > 0 && <section className="panel reveal">
      <h2><Zap size={18} /> {t('Suggested automations', 'أتمتة مقترحة')}</h2>
      <ul className="template-list">{available.map(tpl => <li key={tpl.key}>
        <span><strong>{language === 'ar' ? tpl.ar : tpl.en}</strong><small className="muted">{triggers[tpl.trigger]} <ArrowRight size={12} className="flip-rtl" /> {actions[tpl.action]}</small></span>
        <button className="quiet" disabled={!!busy || data.rules.length >= data.limit} onClick={() => void addTemplate(tpl)}><Plus size={15} />{t('Add', 'إضافة')}</button>
      </li>)}</ul>
    </section>}

    <section className="panel reveal">
      <div className="row"><h2>{t('Your automations', 'أتمتتك')}</h2><button className="primary" disabled={data.rules.length >= data.limit} onClick={() => setDraft({ name: '', trigger: 'task_overdue', action: 'suggest_time_block', conditions: DEFAULTS.task_overdue, action_config: {} })}><Plus size={16} />{t('New automation', 'أتمتة جديدة')}</button></div>
      <ErrorMessage error={failure} />
      {data.rules.length === 0 ? <p className="muted">{t('No automations yet. Add a suggested one or build your own.', 'لا توجد أتمتة بعد. أضف واحدة مقترحة أو أنشئ أتمتتك.')}</p> :
        <ul className="rule-list">{data.rules.map(r => <li key={r.id} className={r.enabled ? '' : 'paused'}>
          <label className="switch"><input type="checkbox" role="switch" checked={r.enabled} disabled={!!busy} onChange={() => void toggle(r)} aria-label={`${r.name} — ${r.enabled ? t('on', 'مفعّلة') : t('off', 'متوقفة')}`} /><span aria-hidden="true" /></label>
          <div className="rule-body">
            <strong>{r.name}</strong>
            <small className="muted">{triggers[r.trigger]} <ArrowRight size={12} className="flip-rtl" /> {actions[r.action]}</small>
            <small className="muted">{r.run_count > 0 ? t(`Ran ${r.run_count} time(s)`, `عملت ${r.run_count} مرة`) : t('Hasn’t run yet', 'لم تعمل بعد')}{r.last_run_at ? ` · ${when(r.last_run_at)}` : ''}{r.failed_runs ? <span className="badge danger-badge"><AlertTriangle size={12} /> {t(`${r.failed_runs} failed`, `${r.failed_runs} فشل`)}</span> : null}</small>
          </div>
          <div className="rule-tools">
            <button className="icon-button" aria-label={t(`Activity for ${r.name}`, `سجل ${r.name}`)} onClick={() => setLogFor(r)}><History size={15} /></button>
            <button className="icon-button" aria-label={t(`Edit ${r.name}`, `تعديل ${r.name}`)} onClick={() => setDraft({ id: r.id, name: r.name, trigger: r.trigger, action: r.action, conditions: { ...r.conditions }, action_config: { ...r.action_config } })}><Pencil size={15} /></button>
            <button className="icon-button" aria-label={t(`Delete ${r.name}`, `حذف ${r.name}`)} disabled={!!busy} onClick={() => void remove(r)}><Trash2 size={15} /></button>
          </div>
        </li>)}</ul>}
    </section>
    {draft && <RuleBuilder draft={draft} catalogue={data.catalogue} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); reload(); toast(t('Automation saved.', 'حُفظت الأتمتة.')) }} />}
    {logFor && <RunLog rule={logFor} onClose={() => setLogFor(null)} />}
  </div>
}

function RuleBuilder({ draft: initial, catalogue, onClose, onSaved }: { draft: Draft; catalogue: Record<string, string[]>; onClose: () => void; onSaved: () => void }) {
  const t = useText(), { triggers, actions } = useAutomationLabels()
  const [draft, setDraft] = useState(initial), [preview, setPreview] = useState<{ subject: string; description: string }[] | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const c = draft.conditions, set = (patch: Conditions) => { setDraft({ ...draft, conditions: { ...c, ...patch } }); setPreview(null) }
  const payload = () => ({ name: draft.name.trim() || triggers[draft.trigger], trigger: draft.trigger, action: draft.action, conditions: draft.conditions, action_config: draft.action === 'notify' && draft.action_config.message ? { message: draft.action_config.message } : {} })
  function changeTrigger(trigger: string) { setDraft({ ...draft, trigger, action: catalogue[trigger][0], conditions: DEFAULTS[trigger] ?? {} }); setPreview(null) }
  async function doPreview() {
    setBusy(true); setError('')
    try { setPreview((await api<{ matches: { subject: string; description: string }[] }>('/api/automations/preview', 'POST', payload())).matches) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('')
    try { await api(draft.id ? `/api/automations/${draft.id}` : '/api/automations', draft.id ? 'PATCH' : 'POST', payload()); onSaved() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  const number = (key: keyof Conditions, label: string, min: number, max: number) => <label>{label}<input type="number" min={min} max={max} value={c[key] ?? ''} onChange={e => set({ [key]: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
  return <Dialog title={draft.id ? t('Edit automation', 'تعديل الأتمتة') : t('New automation', 'أتمتة جديدة')} onClose={onClose}>
    <form className="form-grid rule-builder" onSubmit={save}>
      <label>{t('Name', 'الاسم')}<input value={draft.name} maxLength={120} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder={triggers[draft.trigger]} /></label>
      <fieldset><legend>{t('When', 'عندما')}</legend>
        <label className="sr-only" htmlFor="rule-trigger">{t('Trigger', 'المُشغِّل')}</label>
        <select id="rule-trigger" value={draft.trigger} onChange={e => changeTrigger(e.target.value)} disabled={!!draft.id}>{Object.keys(catalogue).map(k => <option key={k} value={k}>{triggers[k]}</option>)}</select>
        {draft.trigger === 'task_overdue' && <div className="form-row">
          <label>{t('Minimum priority', 'أدنى أولوية')}<select value={c.min_priority ?? 'low'} onChange={e => set({ min_priority: e.target.value })}>{[['low', t('Any', 'أي')], ['medium', t('Medium', 'متوسطة')], ['high', t('High', 'عالية')], ['urgent', t('Urgent', 'عاجلة')]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          {number('overdue_hours', t('Overdue for at least (hours)', 'متأخرة لمدة لا تقل عن (ساعات)'), 0, 720)}
        </div>}
        {draft.trigger === 'focus_completed' && number('min_minutes', t('Session at least (minutes)', 'الجلسة لا تقل عن (دقائق)'), 1, 600)}
        {draft.trigger === 'recurring_task_due' && number('grace_hours', t('Wait after due time (hours)', 'الانتظار بعد الموعد (ساعات)'), 0, 168)}
        {draft.trigger === 'day_overloaded' && <div className="form-row">
          {number('threshold', t('Booked at least (%)', 'محجوز بنسبة لا تقل عن (٪)'), 50, 150)}
          {number('days_ahead', t('Look ahead (days)', 'التطلع للأمام (أيام)'), 1, 7)}
        </div>}
      </fieldset>
      <fieldset><legend>{t('Then', 'ثم')}</legend>
        <label className="sr-only" htmlFor="rule-action">{t('Action', 'الإجراء')}</label>
        <select id="rule-action" value={draft.action} onChange={e => { setDraft({ ...draft, action: e.target.value }); setPreview(null) }}>{catalogue[draft.trigger].map(a => <option key={a} value={a}>{actions[a]}</option>)}</select>
        {draft.action === 'notify' && <label>{t('Message (optional)', 'الرسالة (اختياري)')}<input value={draft.action_config.message ?? ''} maxLength={200} onChange={e => setDraft({ ...draft, action_config: { message: e.target.value } })} /></label>}
      </fieldset>
      <div className="rule-preview" aria-live="polite">
        <button type="button" className="quiet" disabled={busy} onClick={() => void doPreview()}><Eye size={15} />{t('Preview', 'معاينة')}</button>
        {preview && (preview.length === 0 ? <p className="muted">{t('Nothing matches right now. The rule will act when something does.', 'لا يوجد تطابق الآن. ستعمل القاعدة عند حدوث تطابق.')}</p>
          : <ul>{preview.map((m, i) => <li key={i}><strong>{m.subject}</strong><span className="muted">{m.description}</span></li>)}</ul>)}
        {preview && <small className="muted">{t('Preview only — nothing was changed.', 'معاينة فقط — لم يتغير شيء.')}</small>}
      </div>
      <ErrorMessage error={error} />
      <div className="toolbar"><button className="primary" disabled={busy}>{t('Save automation', 'حفظ الأتمتة')}</button><button type="button" className="quiet" onClick={onClose}>{t('Cancel', 'إلغاء')}</button></div>
    </form>
  </Dialog>
}

function RunLog({ rule, onClose }: { rule: Rule; onClose: () => void }) {
  const t = useText(), { language } = useLanguage()
  const { data, error } = useApi<{ data: Run[] }>(`/api/automations/${rule.id}/runs`)
  const label = { succeeded: t('Done', 'تم'), skipped: t('Skipped', 'تُخطّي'), failed: t('Failed', 'فشل'), running: t('Running', 'قيد التنفيذ') }
  return <Dialog title={t(`Activity: ${rule.name}`, `السجل: ${rule.name}`)} onClose={onClose}>
    <ErrorMessage error={error} />
    {!data ? <Skeleton lines={3} /> : data.data.length === 0 ? <p className="muted">{t('No activity yet.', 'لا يوجد نشاط بعد.')}</p> :
      <ul className="run-log">{data.data.map(run => <li key={run.id} className={`run-${run.status}`}>
        <span className={`badge run-badge-${run.status}`}>{label[run.status]}</span>
        <div><strong>{run.subject}</strong><small className="muted">{new Date(run.created_at).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })}{run.attempts > 1 ? ` · ${t(`${run.attempts} attempts`, `${run.attempts} محاولات`)}` : ''}</small>{run.message && <p>{run.message}</p>}{run.error && <p className="error">{run.error}</p>}</div>
      </li>)}</ul>}
  </Dialog>
}
