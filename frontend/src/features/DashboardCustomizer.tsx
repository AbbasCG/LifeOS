import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowDown, ArrowUp, GripVertical, RotateCcw } from 'lucide-react'
import { api } from '../lib/api'
import { WIDGETS, moveItem, normalizeLayout, type DashboardLayout, type WidgetId } from '../lib/dashboard'
import { useText } from '../lib/i18n'
import { useToast } from '../lib/toast'
import { Drawer } from '../components/ui/Shared'

export default function DashboardCustomizer({ layout, onClose, onSaved }: { layout: DashboardLayout; onClose: () => void; onSaved: () => void }) {
  const t = useText(), toast = useToast()
  const [order, setOrder] = useState<WidgetId[]>(layout.order), [hidden, setHidden] = useState<WidgetId[]>(layout.hidden), [busy, setBusy] = useState(false), [dragging, setDragging] = useState<WidgetId | null>(null)
  const list = useRef<HTMLOListElement>(null)
  const names: Record<WidgetId, [string, string]> = {
    today: [t('Briefing & evening summary', 'الإحاطة وملخص المساء'), t('What matters today, and how it went.', 'ما يهم اليوم، وكيف سار.')],
    progress: [t('Today’s progress', 'تقدم اليوم'), t('Tasks, focus and habits at a glance.', 'المهام والتركيز والعادات بنظرة.')],
    focus_time: [t('Available focus time', 'وقت التركيز المتاح'), t('Free slots left today.', 'الفترات المتاحة المتبقية اليوم.')],
    checkin: [t('Daily check-in', 'التسجيل اليومي'), t('Energy, mood and workload.', 'الطاقة والمزاج وعبء العمل.')],
    deadlines: [t('Upcoming deadlines', 'المواعيد القادمة'), t('Tasks, projects and goals due soon.', 'المهام والمشاريع والأهداف المستحقة قريباً.')],
    actions: [t('Quick actions', 'إجراءات سريعة'), t('One tap to capture, focus or plan.', 'نقرة واحدة للإضافة أو التركيز أو التخطيط.')],
    suggestions: [t('Smart suggestions', 'اقتراحات ذكية'), t('Actionable nudges based on your day.', 'تنبيهات عملية حسب يومك.')],
    stats: [t('Today at a glance', 'اليوم بنظرة'), t('Completed, focus, overdue and day load.', 'المنجز والتركيز والمتأخر وحمل اليوم.')],
    next_moves: [t('Your next moves', 'خطواتك التالية'), t('Top tasks ranked with reasons.', 'أهم المهام مرتبة مع الأسباب.')],
    agenda: [t('Today’s agenda', 'جدول اليوم'), t('Your calendar for today.', 'تقويمك لليوم.')],
    habits: [t('Habits today', 'عادات اليوم'), t('One-tap check-ins and streaks.', 'تسجيل بلمسة وسلاسل.')],
    goals: [t('Goals in motion', 'أهداف قيد التقدم'), t('Progress toward active goals.', 'التقدم نحو الأهداف النشطة.')],
    focus: [t('Focus prompt', 'دعوة للتركيز'), t('Jump into a focus session.', 'ابدأ جلسة تركيز.')],
    weekly: [t('Weekly rhythm', 'إيقاع الأسبوع'), t('Focus minutes for the last 7 days.', 'دقائق التركيز لآخر ٧ أيام.')],
    review: [t('This week’s plan', 'خطة هذا الأسبوع'), t('Planned vs actual and weekly review.', 'المخطط مقابل الفعلي والمراجعة.')],
  }
  function onPointerMove(e: ReactPointerEvent<HTMLElement>) {
    if (!dragging || !list.current) return
    const rows = [...list.current.querySelectorAll<HTMLElement>('[data-widget]')]
    const target = rows.findIndex(row => { const r = row.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 })
    const from = order.indexOf(dragging), to = target === -1 ? order.length - 1 : target > from ? target - 1 : target
    if (to !== from) setOrder(moveItem(order, from, to))
  }
  async function save(next: DashboardLayout) {
    setBusy(true)
    try { await api('/api/settings', 'PUT', { dashboard: next }); onSaved(); toast(t('Dashboard updated.', 'تم تحديث لوحة المعلومات.')); onClose() } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }
  const visibleCount = order.filter(id => !hidden.includes(id)).length
  return <Drawer title={t('Customize dashboard', 'تخصيص لوحة المعلومات')} onClose={onClose} footer={<>
    <button className="quiet" disabled={busy} onClick={() => { const d = normalizeLayout(null); setOrder(d.order); setHidden(d.hidden) }}><RotateCcw size={15} />{t('Reset', 'إعادة ضبط')}</button>
    <button className="primary" disabled={busy || visibleCount === 0} onClick={() => void save({ order, hidden })}>{busy ? t('Saving…', 'جارٍ الحفظ…') : t('Save layout', 'حفظ التخطيط')}</button>
  </>}>
    <p className="muted">{t('Show the widgets you need and drag them into the order that works for you. Saved to your account on every device.', 'أظهر الأدوات التي تحتاجها واسحبها بالترتيب المناسب. يُحفظ في حسابك على كل الأجهزة.')}</p>
    <ol className="widget-list" ref={list} onPointerMove={onPointerMove} onPointerUp={() => setDragging(null)} onPointerCancel={() => setDragging(null)}>
      {order.map((id, index) => {
        const visible = !hidden.includes(id)
        return <li key={id} data-widget={id} className={`${dragging === id ? 'dragging' : ''} ${visible ? '' : 'off'}`}>
          <span className="grip" aria-hidden="true" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(id) }}><GripVertical size={16} /></span>
          <span className="widget-name"><strong>{names[id][0]}</strong><small className="muted">{names[id][1]}</small></span>
          <span className="widget-move"><button className="icon-button" disabled={index === 0} aria-label={t(`Move ${names[id][0]} up`, `تحريك ${names[id][0]} لأعلى`)} onClick={() => setOrder(moveItem(order, index, index - 1))}><ArrowUp size={15} /></button><button className="icon-button" disabled={index === order.length - 1} aria-label={t(`Move ${names[id][0]} down`, `تحريك ${names[id][0]} لأسفل`)} onClick={() => setOrder(moveItem(order, index, index + 1))}><ArrowDown size={15} /></button></span>
          <label className="switch"><input type="checkbox" role="switch" checked={visible} onChange={e => setHidden(e.target.checked ? hidden.filter(h => h !== id) : [...hidden, id])} /><span className="sr-only">{t(`Show ${names[id][0]}`, `إظهار ${names[id][0]}`)}</span><i aria-hidden="true" /></label>
        </li>
      })}
    </ol>
    {visibleCount === 0 && <p className="error compact">{t('Keep at least one widget visible.', 'أبقِ أداة واحدة على الأقل ظاهرة.')}</p>}
    <p className="muted small-print">{t(`${WIDGETS.length} widgets available.`, `${WIDGETS.length} أدوات متاحة.`)}</p>
  </Drawer>
}
