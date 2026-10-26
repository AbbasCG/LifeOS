import { NavLink } from 'react-router'
import { m } from 'motion/react'
import { CalendarDays, CheckSquare, Focus, LayoutDashboard, Plus } from 'lucide-react'
import { useText } from '../../lib/i18n'
import { openQuickAdd } from '../../lib/quickAdd'

/**
 * Bottom tab bar for phones: four destinations and Quick Add in the middle, in thumb reach. Everything else is in the
 * menu (top left).
 */
export default function MobileNav() {
  const t = useText()
  const tab = (to: string, label: string, Icon: typeof Plus) => <NavLink to={to} end={to === '/'} className={({ isActive }) => isActive ? 'active' : ''}>{({ isActive }) => <>{isActive && <m.span layoutId="tab-active" className="tab-active" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}<Icon size={22} /><span>{label}</span></>}</NavLink>
  return <nav className="mobile-nav" aria-label={t('Primary', 'التنقل الرئيسي')}>
    {tab('/', t('Today', 'اليوم'), LayoutDashboard)}
    {tab('/tasks', t('Tasks', 'المهام'), CheckSquare)}
    <button type="button" className="tab-add" onClick={openQuickAdd} aria-label={t('Quick add', 'إضافة سريعة')}><span><Plus size={26} /></span></button>
    {tab('/calendar', t('Calendar', 'التقويم'), CalendarDays)}
    {tab('/focus', t('Focus', 'التركيز'), Focus)}
  </nav>
}
