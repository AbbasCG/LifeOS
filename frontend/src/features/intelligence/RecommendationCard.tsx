import { useState } from 'react'
import { Link } from 'react-router'
import { m } from 'motion/react'
import { AlarmClock, CalendarX2, Gauge, Target, Repeat2, Sparkles, ThumbsUp, ThumbsDown, X, ChevronDown, ArrowRight, BellOff } from 'lucide-react'
import { api } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { ErrorMessage } from '../../components/ui/Shared'
import { ProposalCard } from '../assistant/ProposalCard'
import type { AssistantProposal } from '../../lib/api'
import type { Recommendation } from '../../lib/intelligence'
import { confidenceLabel, sourceLabel } from './labels'

const ICONS = { deadline: AlarmClock, conflict: CalendarX2, overload: Gauge, goal: Target, postponed: Repeat2, focus: Sparkles }

/**
 * One proactive suggestion: what was noticed, how sure LifeOS is and from which data, and one next step. Acting on it
 * only prepares a proposal; nothing changes until the proposal is approved.
 */
export function RecommendationCard({ rec, onChange }: { rec: Recommendation; onChange: (id: number, gone: boolean) => void }) {
  const t = useText(), { language } = useLanguage(), toast = useToast(), ar = language === 'ar'
  const [why, setWhy] = useState(false), [menu, setMenu] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [proposal, setProposal] = useState<AssistantProposal | null>(null), [feedback, setFeedback] = useState(rec.feedback)
  const Icon = ICONS[rec.type] ?? Sparkles
  async function call<T>(path: string, body?: unknown) {
    setBusy(true); setError('')
    try { return await api<T>(`/api/recommendations/${rec.id}/${path}`, 'POST', body) } catch (e) { setError((e as Error).message); return null } finally { setBusy(false) }
  }
  async function dismiss(snooze?: number) {
    setMenu(false)
    if (await call('dismiss', snooze ? { snooze_days: snooze } : {})) {
      toast(snooze ? t(`Snoozed for ${snooze} day(s).`, `أُجّل ${snooze} يوم.`) : t('Dismissed. It won’t come back.', 'تم الإخفاء. لن يظهر مجدداً.'))
      onChange(rec.id, true)
    }
  }
  async function rate(useful: boolean) {
    if (await call('feedback', { useful })) { setFeedback(useful ? 'useful' : 'not_useful'); toast(t('Thanks — noted.', 'شكراً — تم التسجيل.')) }
  }
  async function act() {
    const p = await call<AssistantProposal>('act')
    if (p) setProposal(p)
  }
  const evidence = Object.entries(rec.evidence ?? {}).filter(([, v]) => typeof v === 'number' || typeof v === 'string')
  return <m.li layout className={`rec-card sev-${rec.severity} type-${rec.type}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0, marginBottom: 0 }} transition={{ type: 'spring', stiffness: 360, damping: 32 }}>
    <div className="rec-head">
      <span className="rec-icon" aria-hidden="true"><Icon size={17} /></span>
      <div className="rec-text"><strong>{rec.title[ar ? 'ar' : 'en']}</strong><p className="muted small">{rec.detail[ar ? 'ar' : 'en']}</p></div>
      <div className="rec-menu">
        <button className="icon-button" aria-label={t('Dismiss or snooze', 'إخفاء أو تأجيل')} aria-expanded={menu} onClick={() => setMenu(o => !o)}><X size={15} /></button>
        {menu && <div className="rec-popover" role="menu">
          <button role="menuitem" onClick={() => void dismiss()}><X size={13} />{t('Dismiss', 'إخفاء')}</button>
          {[1, 3, 7].map(d => <button key={d} role="menuitem" onClick={() => void dismiss(d)}><BellOff size={13} />{t(`Snooze ${d} day(s)`, `تأجيل ${d} يوم`)}</button>)}
        </div>}
      </div>
    </div>
    <div className="rec-meta">
      <span className={`chip conf-${rec.confidence}`}>{confidenceLabel(rec.confidence, t)}</span>
      {rec.sources.map(s => <span key={s} className="chip">{sourceLabel(s, t)}</span>)}
      <button className="text-link" aria-expanded={why} onClick={() => setWhy(w => !w)}><ChevronDown size={13} className={why ? 'flip' : ''} />{t('Why?', 'لماذا؟')}</button>
    </div>
    {why && <dl className="rec-why">{evidence.length ? evidence.map(([k, v]) => <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd dir="ltr">{String(v)}</dd></div>) : <p className="muted small">{t('Based on the sources above.', 'استناداً إلى المصادر أعلاه.')}</p>}</dl>}
    <ErrorMessage error={error} />
    {proposal ? <ProposalCard proposal={proposal} /> : <div className="rec-actions">
      {rec.action?.kind === 'link' && <Link className="quiet" to={rec.action.to}>{rec.action.label[ar ? 'ar' : 'en']}<ArrowRight size={14} className="flip-rtl" /></Link>}
      {rec.action?.kind === 'proposal' && <button className="quiet" disabled={busy} onClick={() => void act()}>{busy ? t('Preparing…', 'جارٍ التحضير…') : rec.action.label[ar ? 'ar' : 'en']}<ArrowRight size={14} className="flip-rtl" /></button>}
      <span className="rec-feedback" role="group" aria-label={t('Was this useful?', 'هل كان هذا مفيداً؟')}>
        <button className={`icon-button ${feedback === 'useful' ? 'on' : ''}`} aria-pressed={feedback === 'useful'} aria-label={t('Useful', 'مفيد')} disabled={busy} onClick={() => void rate(true)}><ThumbsUp size={14} /></button>
        <button className={`icon-button ${feedback === 'not_useful' ? 'on' : ''}`} aria-pressed={feedback === 'not_useful'} aria-label={t('Not useful', 'غير مفيد')} disabled={busy} onClick={() => void rate(false)}><ThumbsDown size={14} /></button>
      </span>
    </div>}
  </m.li>
}
