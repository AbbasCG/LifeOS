import { useState } from 'react'
import { ArrowDown, ArrowUp, Eye, EyeOff, Lock, Monitor, RotateCcw, Smartphone } from 'lucide-react'
import { api } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { BottomSheet } from '../../components/visual'
import { ErrorMessage } from '../../components/ui/Shared'
import { isDefault, normalizeToday, TODAY_SECTIONS, type Device, type SectionLayout, type TodayLayout, type TodaySection } from '../../lib/todayLayout'

/**
 * Choose and order what Today shows above "More for today", separately for phone and computer. Hidden sections are
 * not lost: they move into "More for today". Nothing is saved until Save.
 */
export function TodayCustomizer({ saved, device, onClose, onSaved }: { saved: TodayLayout; device: Device; onClose: () => void; onSaved: () => void }) {
  const t = useText(), toast = useToast()
  const [tab, setTab] = useState<Device>(device)
  const [drafts, setDrafts] = useState<Record<Device, SectionLayout>>({ phone: normalizeToday(saved.phone), desktop: normalizeToday(saved.desktop) })
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const draft = drafts[tab]
  const names: Record<TodaySection, string> = {
    now: t('Now card', 'بطاقة الآن'), checkin: t('Quick check-in', 'تسجيل سريع'), strip: t('Day strip', 'شريط اليوم'), top3: t('Top 3', 'أهم ٣'), progress: t('Progress rings', 'حلقات التقدم'), focus: t('Focus', 'التركيز'),
    habits: t('Habits', 'العادات'), copilot: t('Copilot pick', 'اقتراح المساعد'), suggestions: t('Suggestions', 'الاقتراحات'),
  }
  const update = (next: SectionLayout) => setDrafts(d => ({ ...d, [tab]: next }))
  const move = (index: number, by: number) => {
    const order = [...draft.order], target = index + by
    if (target < 0 || target >= order.length) return
    ;[order[index], order[target]] = [order[target], order[index]]
    update({ ...draft, order })
  }
  const toggle = (section: TodaySection) => update({ ...draft, hidden: draft.hidden.includes(section) ? draft.hidden.filter(s => s !== section) : [...draft.hidden, section] })

  async function save() {
    setBusy(true); setError('')
    // Only devices that differ from the default are stored, so a reset device follows future defaults.
    const layout: TodayLayout = {}
    for (const d of ['phone', 'desktop'] as Device[]) if (!isDefault(drafts[d])) layout[d] = drafts[d]
    try {
      await api('/api/settings', 'PUT', { today_layout: layout })
      toast(t('Today updated.', 'حُدّث «اليوم».'))
      onSaved(); onClose()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return <BottomSheet title={t('Customize Today', 'تخصيص «اليوم»')} onClose={onClose} footer={<>
    <button type="button" className="quiet" disabled={isDefault(draft)} onClick={() => update(normalizeToday())}><RotateCcw size={16} />{t('Reset', 'استعادة الافتراضي')}</button>
    <button type="button" className="primary" disabled={busy} onClick={() => void save()}>{t('Save', 'حفظ')}</button>
  </>}>
    <div className="segmented today-device" role="radiogroup" aria-label={t('Device', 'الجهاز')}>
      {([['phone', t('Phone', 'الهاتف'), Smartphone], ['desktop', t('Computer', 'الحاسوب'), Monitor]] as const).map(([value, label, Icon]) =>
        <button key={value} type="button" role="radio" aria-checked={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}><Icon size={15} aria-hidden="true" />{label}{value === device && <span className="muted small">{t(' (this one)', ' (هذا)')}</span>}</button>)}
    </div>
    <p className="muted small">{t('Hidden sections move into “More for today”.', 'تنتقل الأقسام المخفية إلى «المزيد لليوم».')}</p>
    <ol className="today-sections">{draft.order.map((section, i) => {
      const hidden = draft.hidden.includes(section)
      return <li key={section} className={hidden ? 'is-hidden' : ''}>
        <span className="today-section-name">{names[section]}{section === 'now' && <small className="muted"><Lock size={12} aria-hidden="true" />{t('Always shown', 'تظهر دائماً')}</small>}</span>
        {section !== 'now' && <button type="button" className="icon-button" aria-pressed={!hidden} onClick={() => toggle(section)} aria-label={hidden ? t(`Show ${names[section]}`, `إظهار ${names[section]}`) : t(`Hide ${names[section]}`, `إخفاء ${names[section]}`)}>{hidden ? <EyeOff size={17} /> : <Eye size={17} />}</button>}
        <button type="button" className="icon-button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t(`Move ${names[section]} up`, `تحريك ${names[section]} لأعلى`)}><ArrowUp size={17} /></button>
        <button type="button" className="icon-button" disabled={i === TODAY_SECTIONS.length - 1} onClick={() => move(i, 1)} aria-label={t(`Move ${names[section]} down`, `تحريك ${names[section]} لأسفل`)}><ArrowDown size={17} /></button>
      </li>
    })}</ol>
    <ErrorMessage error={error} />
  </BottomSheet>
}
