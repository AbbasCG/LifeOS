import { NavLink, Outlet } from 'react-router'
import { SlidersHorizontal, ShieldCheck, CalendarSync, Bot, BellRing, Workflow } from 'lucide-react'
import { useText } from '../../lib/i18n'

export default function SettingsLayout() {
  const t = useText()
  const tabs = [
    { to: '/settings', end: true, label: t('General', 'عام'), icon: SlidersHorizontal },
    { to: '/settings/security', label: t('Security', 'الأمان'), icon: ShieldCheck },
    { to: '/settings/notifications', label: t('Notifications', 'الإشعارات'), icon: BellRing },
    { to: '/settings/integrations', label: t('Calendars', 'التقويمات'), icon: CalendarSync },
    { to: '/settings/assistant', label: t('Assistant', 'المساعد'), icon: Bot },
    { to: '/settings/automations', label: t('Automations', 'الأتمتة'), icon: Workflow },
  ]
  return <div className="settings-hub">
    <nav className="settings-tabs" aria-label={t('Settings sections', 'أقسام الإعدادات')}>
      {tabs.map(({ to, end, label, icon: Icon }) => <NavLink key={to} to={to} end={end} className={({ isActive }) => isActive ? 'active' : ''}><Icon size={17} />{label}</NavLink>)}
    </nav>
    <Outlet />
  </div>
}
