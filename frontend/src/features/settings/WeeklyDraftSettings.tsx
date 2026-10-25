import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Sparkles } from 'lucide-react'
import { api } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import type { PlanTemplate } from '../../lib/copilot'

export type WeeklyDraft = { settings: { enabled: boolean; weekday: number; time: string; template_id: number | null; last_week: string | null }; next_week: string }

const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`)

/**
 * Opt-in weekly plan drafts: on the chosen weekday and time, Copilot prepares next week's plan as a pending proposal in
 * a new conversation and sends one notification. Nothing changes until the user approves it.
 */
export function WeeklyDraftSettings({ disabled }: { disabled?: boolean }) {
  const t = useText(), { language } = useLanguage(), toast = useToast(), navigate = useNavigate()
  const { data, reload } = useApi<WeeklyDraft>('/api/copilot/weekly-draft')
  const templates = useApi<{ templates: PlanTemplate[] }>('/api/copilot/templates')
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState('')
  if (!data) return null
  const s = data.settings
  const days = Array.from({ length: 7 }, (_, d) => new Date(2026, 10, 1 + d).toLocaleDateString(language, { weekday: 'long' }))
  const times = TIMES.includes(s.time) ? TIMES : [...TIMES, s.time].sort()
  async function run<T>(fn: () => Promise<T>, done?: string): Promise<T | null> {
    setBusy(true); setFailure('')
    try { const r = await fn(); if (done) toast(done); reload(); return r } catch (e) { setFailure((e as Error).message); return null } finally { setBusy(false) }
  }
  const save = (patch: Partial<WeeklyDraft['settings']>) => void run(() => api('/api/copilot/weekly-draft', 'PUT', patch), t('Saved.', 'تم الحفظ.'))
  async function prepare() {
    const r = await run(() => api<{ conversation: { id: string } }>('/api/copilot/weekly-draft', 'POST', { language }))
    if (r) navigate(`/assistant?c=${r.conversation.id}`)
  }
  const off = disabled || busy
  return <div className="weekly-draft">
    <div className="ai-toggle">
      <div><label htmlFor="ai-weekly-draft"><strong>{t('Prepare a weekly plan draft', 'إعداد مسودة خطة أسبوعية')}</strong></label>
        <p className="muted small" id="ai-weekly-draft-hint">{t('Opt-in. At the time you choose, Copilot plans the coming week — from a template, or with the week planner and your learned preferences — as a proposal in a new conversation, and sends one planning notification. Nothing changes until you approve it; the draft stays open until the end of that Monday.', 'اختياري. في الوقت الذي تختاره، يخطط المساعد للأسبوع القادم — من قالب، أو بمخطط الأسبوع وتفضيلاتك المتعلَّمة — كاقتراح في محادثة جديدة، ويرسل إشعار تخطيط واحداً. لا يتغير شيء حتى توافق؛ تبقى المسودة متاحة حتى نهاية يوم الاثنين.')}</p></div>
      <label className="switch"><input id="ai-weekly-draft" type="checkbox" role="switch" checked={s.enabled} disabled={off} aria-describedby="ai-weekly-draft-hint" onChange={e => save({ enabled: e.target.checked })} /><span aria-hidden="true" /></label>
    </div>
    <div className="weekly-draft-fields">
      <label>{t('Day', 'اليوم')}<select value={s.weekday} disabled={off} onChange={e => save({ weekday: Number(e.target.value) })}>{days.map((name, d) => <option key={d} value={d}>{name}</option>)}</select></label>
      <label>{t('Time', 'الوقت')}<select value={s.time} disabled={off} onChange={e => save({ time: e.target.value })}>{times.map(v => <option key={v} value={v}>{v}</option>)}</select></label>
      <label>{t('Plan from', 'التخطيط من')}<select value={s.template_id ?? ''} disabled={off} onChange={e => save({ template_id: e.target.value ? Number(e.target.value) : null })}>
        <option value="">{t('Week planner and my preferences', 'مخطط الأسبوع وتفضيلاتي')}</option>
        {(templates.data?.templates ?? []).map(tpl => <option key={tpl.id} value={tpl.id}>{t(`Template: ${tpl.name}`, `قالب: ${tpl.name}`)}</option>)}
      </select></label>
    </div>
    <div className="weekly-draft-actions">
      <button className="quiet" disabled={off} onClick={() => void prepare()}><Sparkles size={15} />{t('Prepare a draft now', 'أعدّ مسودة الآن')}</button>
      {s.last_week && <span className="muted small">{t(`Last scheduled draft: week of ${new Date(`${s.last_week}T12:00:00`).toLocaleDateString('en', { day: 'numeric', month: 'short' })}`, `آخر مسودة مجدولة: أسبوع ${new Date(`${s.last_week}T12:00:00`).toLocaleDateString('ar', { day: 'numeric', month: 'short' })}`)}</span>}
    </div>
    {failure && <p className="error" role="alert">{failure}</p>}
  </div>
}
