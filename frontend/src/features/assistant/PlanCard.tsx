import { AlertTriangle, CalendarRange, Database, EyeOff, Gauge, GitBranch, Lightbulb } from 'lucide-react'
import { useText } from '../../lib/i18n'
import type { ContextSource, CopilotContext, CopilotPlan } from '../../lib/copilot'

/**
 * A multi-step plan: what it is based on, conflicts it found, its expected impact and the alternatives the user can
 * switch to. Switching only produces a new proposal; nothing is applied from here.
 */
export function PlanCard({ plan, disabled, onAlternative }: { plan: CopilotPlan; disabled?: boolean; onAlternative?: (key: string) => void }) {
  const t = useText()
  const impact = plan.impact
  const minutes = (n: unknown) => typeof n === 'number' ? (n >= 60 ? t(`${Math.floor(n / 60)}h ${n % 60 ? `${n % 60}m` : ''}`.trim(), `${Math.floor(n / 60)} س ${n % 60 ? `${n % 60} د` : ''}`.trim()) : t(`${n} min`, `${n} د`)) : '—'
  const metrics: [string, string][] = [
    [t('New blocks', 'فترات جديدة'), String(impact.blocks ?? 0)],
    [t('Planned time', 'الوقت المخطط'), minutes(impact.planned_minutes)],
    ...(typeof impact.tasks_scheduled === 'number' ? [[t('Tasks covered', 'مهام مشمولة'), String(impact.tasks_scheduled)] as [string, string]] : []),
    ...(typeof impact.days === 'number' ? [[t('Days used', 'أيام مستخدمة'), String(impact.days)] as [string, string]] : []),
    ...(typeof impact.capacity_minutes === 'number' ? [[t('Capacity left', 'السعة المتاحة'), minutes(impact.capacity_minutes)] as [string, string]] : []),
    ...(typeof impact.moved_events === 'number' ? [[t('Events moved', 'مواعيد منقولة'), String(impact.moved_events)] as [string, string]] : []),
  ]
  return <section className="plan-card" aria-label={plan.title}>
    <header><CalendarRange size={16} /><strong>{plan.title}</strong></header>
    <dl className="plan-impact" aria-label={t('Expected impact', 'الأثر المتوقع')}>{metrics.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    {plan.explanation.length > 0 && <details className="plan-why"><summary><Lightbulb size={14} />{t('How this plan was made', 'كيف وُضعت هذه الخطة')}</summary><ul>{plan.explanation.map((line, i) => <li key={i}>{line}</li>)}</ul></details>}
    {plan.conflicts.length > 0 && <div className="plan-conflicts" role="note"><p><AlertTriangle size={14} />{t('Needs your attention', 'يحتاج انتباهك')}</p><ul>{plan.conflicts.map((c, i) => <li key={i}><strong>{c.title}</strong> <span className="muted">{c.detail}</span></li>)}</ul></div>}
    {plan.alternatives.length > 1 && onAlternative && <div className="plan-alternatives"><span className="muted"><GitBranch size={13} />{t('Alternatives', 'بدائل')}</span>
      {plan.alternatives.map(a => <button key={a.key} type="button" className={`chip-button small ${a.current ? 'active' : ''}`} aria-pressed={a.current} disabled={disabled || a.current} onClick={() => onAlternative(a.key)}>{a.label}</button>)}
    </div>}
  </section>
}

/** Which data an answer was based on, and whether it left this server. */
export function ContextChips({ context, provider }: { context?: CopilotContext; provider: string | null }) {
  const t = useText()
  if (!context) return null
  const names: Record<string, [string, string]> = { tasks: ['Tasks', 'المهام'], calendar: ['Calendar', 'التقويم'], goals: ['Goals', 'الأهداف'], projects: ['Projects', 'المشاريع'], habits: ['Habits', 'العادات'], focus: ['Focus history', 'سجل التركيز'], workload: ['Workload', 'عبء العمل'], checkins: ['Check-ins', 'تسجيلات الحالة'] }
  const label = (s: ContextSource) => { const n = names[s.source]; return n ? t(n[0], n[1]) : s.source }
  return <div className="context-sources" aria-label={t('Data used for this answer', 'البيانات المستخدمة لهذه الإجابة')}>
    <span className={`source-scope ${context.shared ? 'shared' : 'local'}`}><Database size={12} />{context.shared ? t(`Shared with ${provider === 'anthropic' ? 'Claude' : provider === 'openai' ? 'OpenAI' : 'the AI provider'}:`, `شُورك مع ${provider === 'anthropic' ? 'Claude' : provider === 'openai' ? 'OpenAI' : 'مزود الذكاء الاصطناعي'}:`) : t('Used on this server:', 'استُخدم على هذا الخادم:')}</span>
    {context.sources.length === 0 && <span className="chip">{t('No personal data', 'لا بيانات شخصية')}</span>}
    {context.sources.map(s => <span key={s.source} className="chip">{label(s)}{typeof s.count === 'number' && context.shared ? ` · ${s.count}` : ''}{s.masked ? <span className="masked" title={t('Connected events shared only as “Busy”', 'المواعيد المرتبطة تُشارك كـ«مشغول» فقط')}> <EyeOff size={11} /> {s.masked}</span> : null}</span>)}
  </div>
}

/** AI versus rule-based answers are always labelled. */
export function SourceBadge({ provider }: { provider: string | null }) {
  const t = useText()
  const ai = provider && provider !== 'local'
  return <span className={`badge source-badge ${ai ? 'ai' : 'rules'}`}>{ai ? <>{t('AI', 'ذكاء اصطناعي')} · {provider === 'anthropic' ? 'Claude' : provider === 'openai' ? 'OpenAI' : provider}</> : <><Gauge size={11} />{t('Rule-based · Local assistant', 'قواعد · مساعد محلي')}</>}</span>
}
