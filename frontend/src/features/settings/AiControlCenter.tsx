import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { BrainCircuit, Database, Cloud, BellRing, CalendarCog, ShieldCheck, History, Trash2, RotateCcw } from 'lucide-react'
import { api } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { Dialog, ErrorMessage, Skeleton } from '../../components/ui/Shared'
import type { AiActivity, IntelligencePrefs, IntelligenceSettingsData } from '../../lib/intelligence'

function Toggle({ id, label, hint, checked, disabled, onChange }: { id: string; label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return <div className="ai-toggle">
    <div><label htmlFor={id}><strong>{label}</strong></label>{hint && <p className="muted small" id={`${id}-hint`}>{hint}</p>}</div>
    <label className="switch"><input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} aria-describedby={hint ? `${id}-hint` : undefined} onChange={e => onChange(e.target.checked)} /><span aria-hidden="true" /></label>
  </div>
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <section className="panel reveal ai-section"><h2>{icon}{title}</h2>{children}</section>
}

/**
 * The AI Control Center: what the personal intelligence may do, which data it may read, whether anything may go to an
 * external AI provider, how often it speaks up, what it remembers, and a history of what it did.
 */
export default function AiControlCenter() {
  const t = useText(), { language } = useLanguage(), toast = useToast()
  const { data, error, reload } = useApi<IntelligenceSettingsData>('/api/intelligence/settings')
  const activity = useApi<AiActivity>('/api/intelligence/activity')
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(''), [confirmDelete, setConfirmDelete] = useState(false), [tab, setTab] = useState<'proposals' | 'recommendations' | 'events'>('proposals')
  if (error) return <ErrorMessage error={error} />
  if (!data) return <Skeleton lines={6} />
  const s = data.settings
  const when = (iso: string | null) => iso ? new Date(iso).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' }) : ''
  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setFailure('')
    try { await fn(); toast(done); reload(); activity.reload() } catch (e) { setFailure((e as Error).message) } finally { setBusy(false) }
  }
  const save = (patch: Partial<Omit<IntelligencePrefs, 'features' | 'sources'>> & { features?: Partial<IntelligencePrefs['features']>; sources?: Partial<IntelligencePrefs['sources']> }) =>
    void run(() => api('/api/intelligence/settings', 'PUT', patch), t('Saved.', 'تم الحفظ.'))
  const consent = (key: 'assistant_external' | 'ai_connected_data', value: boolean) => void run(() => api('/api/settings', 'PUT', { [key]: value }), t('Saved.', 'تم الحفظ.'))
  const off = !s.enabled

  const features: [keyof IntelligencePrefs['features'], string, string][] = [
    ['briefing', t('Morning intelligence', 'ذكاء الصباح'), t('Priorities, focus windows and watch-outs on Today.', 'الأولويات وفترات التركيز والتنبيهات في صفحة اليوم.')],
    ['recommendations', t('Proactive suggestions', 'اقتراحات استباقية'), t('Deadlines, conflicts, overloaded days, neglected goals, postponed tasks and focus opportunities.', 'المواعيد والتعارضات والأيام المزدحمة والأهداف المهملة والمهام المؤجلة وفرص التركيز.')],
    ['weekly', t('Weekly intelligence', 'ذكاء الأسبوع'), t('Facts, interpretations and next-week suggestions in your weekly review.', 'الحقائق والتفسيرات واقتراحات الأسبوع القادم في مراجعتك الأسبوعية.')],
    ['planner', t('Planner preferences', 'تفضيلات المخطط'), t('Use your preferred planning strategy below when planning a day.', 'استخدام استراتيجيتك المفضلة أدناه عند تخطيط اليوم.')],
    ['ai_narrative', t('AI-written weekly summary', 'ملخص أسبوعي يكتبه الذكاء الاصطناعي'), t('Optional. Sends only your weekly numbers (never titles) to the external AI provider, and needs external AI to be allowed.', 'اختياري. يرسل أرقامك الأسبوعية فقط (دون العناوين) إلى مزود الذكاء الاصطناعي الخارجي، ويتطلب السماح بالذكاء الاصطناعي الخارجي.')],
  ]
  const sources: [keyof IntelligencePrefs['sources'], string, string][] = [
    ['calendar', t('Calendar', 'التقويم'), t('Your events, for availability, conflicts and workload.', 'مواعيدك، للتوفر والتعارضات وحِمل العمل.')],
    ['connected', t('Connected calendars', 'التقويمات المرتبطة'), t('Events from Google, Outlook and subscriptions.', 'مواعيد Google وOutlook والاشتراكات.')],
    ['goals', t('Goals', 'الأهداف'), t('Goal pace and progress.', 'وتيرة الأهداف وتقدمها.')],
    ['habits', t('Habits', 'العادات'), t('Streaks and consistency.', 'السلاسل والالتزام.')],
    ['focus', t('Focus history', 'سجل التركيز'), t('Past focus sessions, to estimate how much deep work fits.', 'جلسات التركيز السابقة، لتقدير العمل العميق المتاح.')],
    ['checkins', t('Energy check-ins', 'تسجيلات الطاقة'), t('Only used by the planner when check-ins are on.', 'يستخدمها المخطط فقط عند تفعيل التسجيلات.')],
  ]
  const freq: [IntelligencePrefs['frequency'], string][] = [['off', t('Off', 'إيقاف')], ['quiet', t('In-app only', 'داخل التطبيق فقط')], ['daily', t('Daily digest', 'ملخص يومي')]]
  const strategies: [string, string][] = [['', t('Automatic', 'تلقائي')], ['balanced', t('Balanced', 'متوازن')], ['deep', t('Deep focus first', 'التركيز العميق أولاً')], ['light', t('Light day', 'يوم خفيف')], ['deadlines', t('Deadlines first', 'المواعيد النهائية أولاً')]]
  const actionName: Record<string, string> = {
    ai_action_executed: t('Applied a Copilot proposal', 'طُبّق اقتراح المساعد'), ai_action_undone: t('Undid a Copilot proposal', 'تم التراجع عن اقتراح'), recommendation_acted: t('Turned a suggestion into a proposal', 'حُوّل اقتراح إلى عرض'),
    recommendation_dismissed: t('Dismissed a suggestion', 'أُخفي اقتراح'), ai_settings_changed: t('Changed AI settings', 'تغيير إعدادات الذكاء الاصطناعي'), ai_personalization_reset: t('Reset personalization', 'إعادة ضبط التخصيص'),
    ai_data_deleted: t('Deleted AI data', 'حذف بيانات الذكاء الاصطناعي'), conversation_deleted: t('Deleted Copilot conversations', 'حذف محادثات المساعد'), calendar_write: t('Changed a connected calendar (confirmed)', 'تغيير تقويم مرتبط (مؤكد)'), calendar_write_failed: t('Calendar change refused', 'رُفض تغيير التقويم'),
    calendar_write_granted: t('Allowed adding events', 'السماح بإضافة المواعيد'), calendar_write_enabled: t('Turned on adding events', 'تفعيل إضافة المواعيد'), calendar_write_disabled: t('Turned off adding events', 'إيقاف إضافة المواعيد'),
  }

  return <div className="settings-stack ai-center">
    <section className="panel reveal integration-intro">
      <BrainCircuit size={22} />
      <div><h2>{t('AI Control Center', 'مركز التحكم بالذكاء الاصطناعي')}</h2>
        <p className="muted">{t('LifeOS computes insights on this server from your own data. It never changes your tasks or calendars on its own — every change is a proposal you approve, and you can undo it.', 'يحسب LifeOS الرؤى على هذا الخادم من بياناتك. لا يغيّر مهامك أو تقاويمك من تلقاء نفسه — كل تغيير اقتراح توافق عليه ويمكنك التراجع عنه.')}</p></div>
      <label className="switch"><input type="checkbox" role="switch" aria-label={t('Personal intelligence', 'الذكاء الشخصي')} checked={s.enabled} disabled={busy} onChange={e => save({ enabled: e.target.checked })} /><span aria-hidden="true" /></label>
    </section>
    <ErrorMessage error={failure} />
    {off && <p className="banner">{t('Personal intelligence is off. Today, the planner and Copilot keep working without proactive insights.', 'الذكاء الشخصي متوقف. تبقى صفحة اليوم والمخطط والمساعد تعمل دون رؤى استباقية.')}</p>}

    <Section icon={<BrainCircuit size={18} />} title={t('Features', 'الميزات')}>
      {features.map(([key, label, hint]) => <Toggle key={key} id={`ai-f-${key}`} label={label} hint={hint} checked={s.features[key]} disabled={busy || off} onChange={v => save({ features: { [key]: v } })} />)}
    </Section>

    <Section icon={<Database size={18} />} title={t('Data the intelligence may read', 'البيانات التي يمكن للذكاء قراءتها')}>
      <p className="muted small">{t('Tasks are always used. Turning a source off removes it from every insight and suggestion.', 'تُستخدم المهام دائماً. إيقاف مصدر يزيله من كل رؤية واقتراح.')}</p>
      {sources.map(([key, label, hint]) => <Toggle key={key} id={`ai-s-${key}`} label={label} hint={hint} checked={s.sources[key]} disabled={busy || off} onChange={v => save({ sources: { [key]: v } })} />)}
    </Section>

    <Section icon={<Cloud size={18} />} title={t('External AI provider', 'مزود الذكاء الاصطناعي الخارجي')}>
      <p className="muted small">{data.external_ai.provider ? t(`Configured: ${data.external_ai.provider.label} (${data.external_ai.provider.model}).`, `المُعدّ: ${data.external_ai.provider.label} (${data.external_ai.provider.model}).`) : t('No external provider is configured on this server; everything stays local.', 'لا يوجد مزود خارجي مُعدّ على هذا الخادم؛ يبقى كل شيء محلياً.')} <Link to="/settings/assistant">{t('Provider details', 'تفاصيل المزود')}</Link></p>
      <Toggle id="ai-ext" label={t('Allow an external AI provider', 'السماح بمزود ذكاء اصطناعي خارجي')} hint={t('For Copilot conversations and the optional weekly summary. Off = local only.', 'لمحادثات المساعد والملخص الأسبوعي الاختياري. الإيقاف = محلي فقط.')} checked={data.external_ai.allowed} disabled={busy} onChange={v => consent('assistant_external', v)} />
      <Toggle id="ai-conn" label={t('Share connected-calendar details with it', 'مشاركة تفاصيل التقويمات المرتبطة معه')} hint={t('Off by default: connected events are sent only as “Busy”, and imported tasks are never sent.', 'متوقف افتراضياً: تُرسل المواعيد المرتبطة كـ«مشغول» فقط ولا تُرسل المهام المستوردة أبداً.')} checked={data.external_ai.connected_data} disabled={busy} onChange={v => consent('ai_connected_data', v)} />
    </Section>

    <Section icon={<BellRing size={18} />} title={t('Suggestions and personalization', 'الاقتراحات والتخصيص')}>
      <div className="ai-row"><strong id="ai-freq">{t('How often LifeOS speaks up', 'متى يتحدث LifeOS')}</strong>
        <div className="segmented" role="radiogroup" aria-labelledby="ai-freq">{freq.map(([v, label]) => <button key={v} role="radio" aria-checked={s.frequency === v} className={s.frequency === v ? 'active' : ''} disabled={busy || off} onClick={() => save({ frequency: v })}>{label}</button>)}</div></div>
      <p className="muted small">{t('“Daily digest” adds at most one notification a day (respecting quiet hours). Suggestions are never shown again once dismissed.', '«الملخص اليومي» يضيف إشعاراً واحداً يومياً على الأكثر (مع احترام ساعات الهدوء). لا يُعاد عرض اقتراح بعد إخفائه.')} <Link to="/settings/notifications">{t('Notification settings', 'إعدادات الإشعارات')}</Link></p>
      <Toggle id="ai-pers" label={t('Learn from my feedback', 'التعلم من ملاحظاتي')} hint={t(`Opt-in. Suggestion types you mark “not useful” three times or more are shown less (urgent ones always show). ${data.counts.feedback} rating(s) stored.`, `اختياري. أنواع الاقتراحات التي تصفها بـ«غير مفيد» ثلاث مرات أو أكثر تظهر أقل (العاجلة تظهر دائماً). ${data.counts.feedback} تقييم محفوظ.`)} checked={s.personalization} disabled={busy || off} onChange={v => save({ personalization: v })} />
      <Toggle id="ai-conv-pers" label={t('Personalize Copilot suggestions', 'تخصيص اقتراحات المساعد')} hint={t('Opt-in. Suggested prompts are ordered by the kinds of request you make most often, counted from your own conversations on this server. Nothing else is inferred or stored.', 'اختياري. تُرتَّب الطلبات المقترحة حسب أنواع الطلبات التي تستخدمها أكثر، محسوبة من محادثاتك على هذا الخادم فقط. لا يُستنتج أو يُخزَّن شيء آخر.')} checked={!!s.features.conversation_personalization} disabled={busy || off} onChange={v => save({ features: { conversation_personalization: v } })} />
      <button className="quiet" disabled={busy || (data.counts.feedback === 0 && !s.features.conversation_personalization)} onClick={() => void run(() => api('/api/intelligence/reset-personalization', 'POST'), t('Personalization reset.', 'تمت إعادة ضبط التخصيص.'))}><RotateCcw size={15} />{t('Reset personalization', 'إعادة ضبط التخصيص')}</button>
    </Section>

    <Section icon={<CalendarCog size={18} />} title={t('Planning preferences', 'تفضيلات التخطيط')}>
      <div className="ai-row"><label htmlFor="ai-strategy"><strong>{t('Preferred planning strategy', 'استراتيجية التخطيط المفضلة')}</strong></label>
        <select id="ai-strategy" value={s.planning_strategy ?? ''} disabled={busy || off || !s.features.planner} onChange={e => save({ planning_strategy: (e.target.value || null) as IntelligencePrefs['planning_strategy'] })}>{strategies.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></div>
      <p className="muted small">{t('Low energy always suggests a light day first. Focus hours, working hours and buffers are in', 'الطاقة المنخفضة تقترح دائماً يوماً خفيفاً أولاً. ساعات التركيز والعمل والفواصل في')} <Link to="/settings">{t('General settings', 'الإعدادات العامة')}</Link>.</p>
    </Section>

    <Section icon={<ShieldCheck size={18} />} title={t('Privacy and retention', 'الخصوصية والاحتفاظ')}>
      <div className="ai-row"><label htmlFor="ai-retention"><strong>{t('Keep suggestion history for', 'الاحتفاظ بسجل الاقتراحات لمدة')}</strong></label>
        <select id="ai-retention" value={s.retention_days} disabled={busy} onChange={e => save({ retention_days: Number(e.target.value) })}>{data.options.retention_days.map(d => <option key={d} value={d}>{t(`${d} days`, `${d} يوماً`)}</option>)}</select></div>
      <p className="muted small">{t(`LifeOS stores no profile about you: insights are recomputed from your data each time. Stored: suggestions (with your ratings), Copilot proposals and Copilot conversations (${data.counts.conversations ?? 0}). The same retention period applies to conversations.`, `لا يخزّن LifeOS ملفاً شخصياً عنك: تُعاد حساب الرؤى من بياناتك في كل مرة. المخزّن: الاقتراحات (مع تقييماتك) واقتراحات المساعد ومحادثات المساعد (${data.counts.conversations ?? 0}). تنطبق مدة الاحتفاظ نفسها على المحادثات.`)} <Link to="/assistant">{t('Manage conversations', 'إدارة المحادثات')}</Link></p>
      <button className="danger" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={15} />{t('Delete AI data…', 'حذف بيانات الذكاء الاصطناعي…')}</button>
    </Section>

    <Section icon={<History size={18} />} title={t('AI activity', 'نشاط الذكاء الاصطناعي')}>
      <div className="segmented" role="tablist" aria-label={t('Activity', 'النشاط')}>
        {([['proposals', t('Proposals', 'الاقتراحات المعروضة')], ['recommendations', t('Suggestions', 'الاقتراحات')], ['events', t('Log', 'السجل')]] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}
      </div>
      {!activity.data ? <Skeleton lines={3} /> : <ul className="ai-activity">
        {tab === 'proposals' && (activity.data.proposals.length ? activity.data.proposals.map(p => <li key={p.id}><span className={`badge proposal-${p.status}`}>{p.status}</span><span className="grow">{p.summary}</span><small className="muted">{p.provider} · {when(p.created_at)}</small></li>) : <li className="muted">{t('No proposals yet.', 'لا اقتراحات بعد.')}</li>)}
        {tab === 'recommendations' && (activity.data.recommendations.length ? activity.data.recommendations.map(r => <li key={r.id}><span className={`badge rec-${r.status}`}>{r.status}</span><span className="grow">{r.title[language === 'ar' ? 'ar' : 'en']}</span><small className="muted">{r.feedback ? (r.feedback === 'useful' ? '👍' : '👎') : ''} {when(r.first_seen_at)}</small></li>) : <li className="muted">{t('No suggestions yet.', 'لا اقتراحات بعد.')}</li>)}
        {tab === 'events' && (activity.data.events.length ? activity.data.events.map((e, i) => <li key={i}><span className="grow">{actionName[e.action] ?? e.action}</span><small className="muted">{when(e.at)}</small></li>) : <li className="muted">{t('Nothing logged yet.', 'لا شيء مسجّل بعد.')}</li>)}
      </ul>}
    </Section>

    {confirmDelete && <Dialog title={t('Delete AI data?', 'حذف بيانات الذكاء الاصطناعي؟')} onClose={() => setConfirmDelete(false)}>
      <p>{t(`This permanently deletes ${data.counts.recommendations} suggestion(s) with your ratings, ${data.counts.proposals} Copilot proposal(s) and ${data.counts.conversations ?? 0} conversation(s). Applied proposals can no longer be undone afterwards.`, `سيحذف هذا نهائياً ${data.counts.recommendations} اقتراحاً مع تقييماتك و${data.counts.proposals} اقتراحاً من المساعد و${data.counts.conversations ?? 0} محادثة. لن يمكن التراجع عن الاقتراحات المطبقة بعدها.`)}</p>
      <p className="muted small">{t('Your tasks, events, goals and habits are not touched. The security log of applied changes is kept.', 'لا تتأثر مهامك ومواعيدك وأهدافك وعاداتك. يُحتفظ بسجل الأمان للتغييرات المطبقة.')}</p>
      <div className="toolbar"><button className="quiet" onClick={() => setConfirmDelete(false)}>{t('Cancel', 'إلغاء')}</button>
        <button className="danger" disabled={busy} onClick={() => { setConfirmDelete(false); void run(() => api('/api/intelligence/data', 'DELETE'), t('AI data deleted.', 'حُذفت بيانات الذكاء الاصطناعي.')) }}>{t('Delete permanently', 'حذف نهائي')}</button></div>
    </Dialog>}
  </div>
}
