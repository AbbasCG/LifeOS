import { NavLink } from 'react-router'
import { LayoutDashboard, CheckSquare, CalendarDays, Focus, Menu } from 'lucide-react'
import { useText } from '../../lib/i18n'

/** Bottom tab bar for small screens; the full navigation stays in the sidebar drawer. */
export default function MobileNav({ onMore }: { onMore: () => void }) {
  const t = useText()
  const items = [
    { to: '/', label: t('Today', 'اليوم'), icon: LayoutDashboard },
    { to: '/tasks', label: t('Tasks', 'المهام'), icon: CheckSquare },
    { to: '/calendar', label: t('Calendar', 'التقويم'), icon: CalendarDays },
    { to: '/focus', label: t('Focus', 'التركيز'), icon: Focus },
  ]
  return <nav className="mobile-nav" aria-label={t('Primary', 'التنقل الرئيسي')}>
    {items.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => isActive ? 'active' : ''}><Icon size={21} /><span>{label}</span></NavLink>)}
    <button type="button" onClick={onMore}><Menu size={21} /><span>{t('More', 'المزيد')}</span></button>
  </nav>
}
