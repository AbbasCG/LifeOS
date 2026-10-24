import { useState } from 'react'
import { HeartPulse, Trash2, Info, Lightbulb } from 'lucide-react'
import { api, type Checkin, type CheckinInsights } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { useSensitiveAction } from '../../lib/sensitive'
import { Dialog, ErrorMessage, Skeleton } from '../../components/ui/Shared'
import { CheckinCard } from '../wellbeing/CheckinCard'

export default function WellbeingSettings() {
  const t = useText(), { language } = useLanguage(), toast = useToast(), sensitive = useSensitiveAction()
  const list = useApi<{ enabled: boolean; today: Checkin | null; items: Checkin[] }>('/api/checkins?days=30')
  const insights = useApi<CheckinInsights>('/api/checkins/insights?days=60')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirming, setConfirming] = useState(false)
  const ar = language === 'ar'
  async function setEnabled(enabled: boolean) {
    setBusy(true); setError('')
    try { await api('/api/settings', 'PUT', { checkins_enabled: enabled }); toast(enabled ? t('Daily check-ins turned on.', 'تم تفعيل التسجيل اليومي.') : t('Daily check-ins turned off. Your history is kept until you delete it.', 'تم إيقاف التسجيل اليومي. يبقى سجلك حتى تحذفه.')); list.reload(); insights.reload() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function deleteAll() {
    setBusy(true); setError('')
    try { await sensitive(() => api('/api/checkins', 'DELETE')); setConfirming(false); toast(t('Check-in history deleted.', 'حُذف سجل التسجيلات.')); list.reload(); insights.reload() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const fmt = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(language, { weekday: 'short', day: 'numeric', month: 'short' })
  if (list.error) return <ErrorMessage error={list.error} />
  if (!list.data) return <Skeleton lines={4} />
  const enabled = list.data.enabled
  return <div className="settings-stack">
    <section className="panel reveal integration-intro">
      <HeartPulse size={22} />
      <div><h2>{t('Energy & wellbeing', 'الطاقة والرفاه')}</h2><p className="muted">{t('An optional daily check-in for energy, mood, stress, workload and sleep. LifeOS uses it to suggest lighter or heavier days and to show patterns next to your focus data. It is never shared with AI providers and is not medical advice.', 'تسجيل يومي اختياري للطاقة والمزاج والتوتر وعبء العمل والنوم. يستخدمه LifeOS لاقتراح أيام أخف أو أثقل ولعرض أنماط بجانب بيانات تركيزك. لا يُشارك مع مزودي الذكاء الاصطناعي وليس نصيحة طبية.')}</p></div>
    </section>
    <section className="panel reveal">
      <label className="toggle-row"><input type="checkbox" checked={enabled} disabled={busy} onChange={e => void setEnabled(e.target.checked)} /><span><strong>{t('Daily check-ins', 'التسجيل اليومي')}</strong><small className="muted">{t('When off, LifeOS stops asking and ignores past entries for planning.', 'عند الإيقاف يتوقف LifeOS عن السؤال ويتجاهل الإدخالات السابقة في التخطيط.')}</small></span></label>
      <ErrorMessage error={error} />
    </section>
    {enabled && <section className="panel reveal"><h2>{t('Today', 'اليوم')}</h2><CheckinCard key={list.data.today?.updated_at ?? 'new'} initial={list.data.today} onSaved={() => { list.reload(); insights.reload() }} /></section>}
    {insights.data && insights.data.checked_in_days > 0 && <section className="panel reveal">
      <h2><Lightbulb size={18} /> {t('Patterns in your data', 'أنماط في بياناتك')}</h2>
      {insights.data.findings.length === 0 ? <p className="muted">{t(`Not enough check-ins yet to compare (you have ${insights.data.checked_in_days}). Patterns appear after at least 3 days in each group.`, `لا توجد تسجيلات كافية للمقارنة بعد (لديك ${insights.data.checked_in_days}). تظهر الأنماط بعد ٣ أيام على الأقل في كل مجموعة.`)}</p>
        : <ul className="finding-list">{insights.data.findings.map(f => <li key={f.key} className={`finding-${f.type}`}>{ar ? f.ar : f.en}</li>)}</ul>}
      <p className="muted small"><Info size={14} />{ar ? insights.data.note.ar : insights.data.note.en}</p>
    </section>}
    <section className="panel reveal">
      <div className="row"><h2>{t('History', 'السجل')}</h2>{list.data.items.length > 0 && <button className="danger" disabled={busy} onClick={() => setConfirming(true)}><Trash2 size={15} />{t('Delete all check-ins', 'حذف كل التسجيلات')}</button>}</div>
      {list.data.items.length === 0 ? <p className="muted">{t('No check-ins yet.', 'لا توجد تسجيلات بعد.')}</p> :
        <ul className="checkin-history">{list.data.items.map(c => <li key={c.date}>
          <strong>{fmt(c.date)}</strong>
          <span className="checkin-values">{[[t('Energy', 'الطاقة'), c.energy], [t('Mood', 'المزاج'), c.mood], [t('Stress', 'التوتر'), c.stress], [t('Workload', 'العبء'), c.workload]].filter(([, v]) => v != null).map(([l, v]) => <span key={String(l)} className="chip">{l} {v}/5</span>)}{c.sleep_minutes != null && <span className="chip">{t('Sleep', 'النوم')} {Math.round(c.sleep_minutes / 6) / 10}{t('h', 'س')}</span>}</span>
          {c.reflection && <small className="muted">{c.reflection}</small>}
        </li>)}</ul>}
    </section>
    {confirming && <Dialog title={t('Delete all check-ins?', 'حذف كل التسجيلات؟')} onClose={() => setConfirming(false)}>
      <p>{t('This permanently deletes your whole check-in history. Tasks, focus sessions and everything else stay untouched.', 'سيؤدي هذا إلى حذف سجل تسجيلاتك نهائياً. تبقى المهام وجلسات التركيز وكل شيء آخر كما هي.')}</p>
      <div className="toolbar"><button className="danger" disabled={busy} onClick={() => void deleteAll()}>{t('Delete permanently', 'حذف نهائي')}</button><button className="quiet" onClick={() => setConfirming(false)}>{t('Cancel', 'إلغاء')}</button></div>
    </Dialog>}
  </div>
}
