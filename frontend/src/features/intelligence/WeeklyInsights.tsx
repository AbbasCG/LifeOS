import { useState } from 'react'
import { Link } from 'react-router'
import { Ruler, Lightbulb, FileText, Bot, ListChecks, ArrowRight } from 'lucide-react'
import { api } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { ErrorMessage } from '../../components/ui/Shared'
import type { Narrative, WeeklyFact, WeeklyIntelligenceData } from '../../lib/intelligence'
import { confidenceLabel } from './labels'

/**
 * Weekly intelligence: measured facts first, then clearly labelled interpretations that cite the facts they rest on,
 * the workload pattern, and suggestions for next week. An AI-written summary is optional and always labelled.
 */
export function WeeklyInsights({ week, data }: { week: string; data: Extract<WeeklyIntelligenceData, { enabled: true }> }) {
  const t = useText(), { language } = useLanguage(), ar = language === 'ar'
  const [narrative, setNarrative] = useState<Narrative | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const factName: Record<string, string> = {
    completed: t('Tasks completed', 'مهام منجزة'), unfinished: t('Still open', 'ما زالت مفتوحة'), focus_minutes: t('Focus minutes', 'دقائق التركيز'), on_time_rate: t('On time', 'في الوقت'),
    estimate_overruns: t('Over estimate', 'تجاوزت التقدير'), habit_consistency: t('Habit consistency', 'التزام العادات'), plan_follow_through: t('Plan follow-through', 'تنفيذ الخطة'), goals_needing_attention: t('Goals needing attention', 'أهداف تحتاج اهتماماً'),
  }
  const value = (f: WeeklyFact) => f.value === null ? '—' : f.unit === 'percent' ? `${f.value}%` : String(f.value)
  const max = Math.max(60, ...data.workload.map(d => Math.max(d.committed_minutes, d.focus_minutes)))
  async function summarise() {
    setBusy(true); setError('')
    try { setNarrative(await api<Narrative>(`/api/reviews/${week}/narrative`, 'POST')) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const reason = narrative?.fallback_reason && ({ disabled: t('AI summaries are off in the AI Control Center, so this is a rule-based summary.', 'ملخصات الذكاء الاصطناعي متوقفة في مركز التحكم، لذا هذا ملخص قائم على القواعد.'),
    not_available: t('No external AI provider is allowed or configured, so this is a rule-based summary.', 'لا يوجد مزود ذكاء اصطناعي خارجي مسموح أو مُعدّ، لذا هذا ملخص قائم على القواعد.'),
    provider_error: t('The AI provider did not answer, so this rule-based summary was used instead.', 'لم يستجب مزود الذكاء الاصطناعي، فاستُخدم هذا الملخص القائم على القواعد.') })[narrative.fallback_reason]

  return <section className="panel reveal wide weekly-insights" aria-labelledby="weekly-insights-title">
    <h2 id="weekly-insights-title">{t('Weekly intelligence', 'ذكاء الأسبوع')}</h2>
    <h3 className="label-measured"><Ruler size={15} />{t('Measured', 'مُقاس')}</h3>
    <dl className="fact-grid">{data.facts.map(f => <div key={f.key}><dt>{factName[f.key] ?? f.key}</dt><dd>{value(f)}{f.change_percent !== undefined && f.change_percent !== null && <small className={f.change_percent >= 0 ? 'up' : 'down'}>{f.change_percent >= 0 ? '+' : ''}{f.change_percent}%</small>}</dd></div>)}</dl>

    <h3 className="label-interpreted"><Lightbulb size={15} />{t('Interpretations · rule-based', 'تفسيرات · قائمة على القواعد')}</h3>
    {data.interpretations.length ? <ul className="interpretations">{data.interpretations.map(i => <li key={i.key}>
      <p>{i[ar ? 'ar' : 'en']}</p>
      <div className="metadata"><span className={`chip conf-${i.confidence}`}>{confidenceLabel(i.confidence, t)}</span>{i.evidence.map(e => <span key={e} className="chip">{t('From', 'من')}: {factName[e] ?? (e === 'workload' ? t('Workload', 'حِمل العمل') : e)}</span>)}</div>
    </li>)}</ul> : <p className="muted small">{t('No clear patterns this week — not enough evidence to say more.', 'لا أنماط واضحة هذا الأسبوع — لا أدلة كافية لقول المزيد.')}</p>}

    <h3><ListChecks size={15} />{t('Workload pattern', 'نمط حِمل العمل')}</h3>
    <ul className="workload-bars" aria-label={t('Committed time and focus per day', 'الوقت الملتزم والتركيز لكل يوم')}>{data.workload.map(d => <li key={d.date}>
      <span className="wd">{new Date(`${d.date}T12:00:00`).toLocaleDateString(language, { weekday: 'short' })}</span>
      <span className="bars" aria-label={t(`${d.committed_minutes} min committed, ${d.focus_minutes} min focus, ${d.completed} done`, `${d.committed_minutes} دقيقة ملتزمة، ${d.focus_minutes} دقيقة تركيز، ${d.completed} منجزة`)}>
        <i className="committed" style={{ width: `${d.committed_minutes / max * 100}%` }} /><i className="focus" style={{ width: `${d.focus_minutes / max * 100}%` }} /></span>
      <small className="muted">{d.completed} ✓</small>
    </li>)}</ul>
    <p className="legend muted small"><i className="committed" /> {t('Committed', 'ملتزم')} <i className="focus" /> {t('Focus', 'تركيز')}</p>

    {data.suggestions.length > 0 && <><h3>{t('For next week', 'للأسبوع القادم')}</h3><ul className="next-week">{data.suggestions.map(s => <li key={s.key}>{s.link ? <Link to={s.link}>{s[ar ? 'ar' : 'en']}<ArrowRight size={13} className="flip-rtl" /></Link> : s[ar ? 'ar' : 'en']}</li>)}</ul></>}

    <div className="narrative">
      {narrative ? <blockquote className={`kind-${narrative.kind}`}>
        <span className="chip">{narrative.kind === 'ai' ? <><Bot size={12} />{t(`AI-written by ${narrative.provider} from the numbers above`, `كتبه ${narrative.provider} من الأرقام أعلاه`)}</> : <><FileText size={12} />{t('Rule-based summary', 'ملخص قائم على القواعد')}</>}</span>
        <p>{narrative.text}</p>{reason && <small className="muted">{reason}</small>}
      </blockquote> : <button className="quiet" disabled={busy} onClick={() => void summarise()}><FileText size={15} />{busy ? t('Summarising…', 'جارٍ التلخيص…') : t('Summarise my week', 'لخّص أسبوعي')}</button>}
      {!data.narrative_available && !narrative && <small className="muted">{t('Rule-based unless AI summaries are enabled in the AI Control Center.', 'قائم على القواعد ما لم تُفعَّل ملخصات الذكاء الاصطناعي في مركز التحكم.')}</small>}
      <ErrorMessage error={error} />
    </div>
  </section>
}
