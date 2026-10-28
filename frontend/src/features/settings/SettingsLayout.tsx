import { NavLink, Outlet, useLocation } from 'react-router'
import { SlidersHorizontal, ShieldCheck, CalendarSync, Bot, BellRing, Workflow, HeartPulse, BrainCircuit } from 'lucide-react'
import { useText } from '../../lib/i18n'

export default function SettingsLayout() {
  const t = useText(), { pathname } = useLocation()
  const tabs = [
    { to: '/settings', end: true, label: t('General', 'عام'), icon: SlidersHorizontal },
    { to: '/settings/security', label: t('Security', 'الأمان'), icon: ShieldCheck },
    { to: '/settings/wellbeing', label: t('Wellbeing', 'الرفاه'), icon: HeartPulse },
    { to: '/settings/notifications', label: t('Notifications', 'الإشعارات'), icon: BellRing },
    { to: '/settings/integrations', label: t('Connected accounts', 'الحسابات المرتبطة'), icon: CalendarSync },
    { to: '/settings/ai', label: t('AI Control Center', 'مركز الذكاء الاصطناعي'), icon: BrainCircuit },
    { to: '/settings/assistant', label: t('Assistant', 'المساعد'), icon: Bot },
    { to: '/settings/automations', label: t('Automations', 'الأتمتة'), icon: Workflow },
  ]
  // General settings has its own visible heading; the other sections get one for screen readers and the outline.
  const section = tabs.find(tab => tab.to !== '/settings' && pathname.startsWith(tab.to))
  return <div className="settings-hub">
    {section && <h1 className="sr-only">{t(`Settings: ${section.label}`, `الإعدادات: ${section.label}`)}</h1>}
    <nav className="settings-tabs" aria-label={t('Settings sections', 'أقسام الإعدادات')}>
      {tabs.map(({ to, end, label, icon: Icon }) => <NavLink key={to} to={to} end={end} className={({ isActive }) => isActive ? 'active' : ''}><Icon size={17} />{label}</NavLink>)}
    </nav>
    <Outlet />
  </div>
}
