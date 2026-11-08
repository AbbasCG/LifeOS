import { Compass, Gift, BarChart3, CalendarDays, CheckSquare, Focus, LayoutDashboard, Settings, Target, X, Sparkles, Heart, Flag, Tags, CalendarCheck, ClipboardCheck, Download, CalendarRange, Languages, Moon, Sun, LogOut } from 'lucide-react'
import { signOutKeepingQueue } from '../../lib/offline'
import { useState } from 'react'
import { NavLink } from 'react-router'
import { NewBadge } from '../../features/discovery/NewBadge'
import { m } from 'motion/react'
import { useLanguage } from '../../contexts/LanguageContext'
import { useTheme } from '../../contexts/ThemeContext'
import { useAuth } from '../../contexts/AuthContext'
import { useInstallPrompt } from '../../lib/pwa'
import { InstallLink } from '../InstallApp'
import { api } from '../../lib/api'
import { ErrorMessage } from '../ui/Shared'

/** Navigation, grouped so the daily destinations come first. Language, theme and sign-out live here on phones. */
const groups = [
  { en: '', ar: '', items: [{ to: '/', en: 'Today', ar: 'اليوم', icon: LayoutDashboard }, { to: '/tasks', en: 'Tasks', ar: 'المهام', icon: CheckSquare }, { to: '/calendar', en: 'Calendar', ar: 'التقويم', icon: CalendarDays }, { to: '/focus', en: 'Focus', ar: 'التركيز', icon: Focus }, { to: '/assistant', en: 'Copilot', ar: 'المساعد', icon: Sparkles }] },
  { en: 'Plan', ar: 'التخطيط', items: [{ to: '/timeline', en: 'Timeline', ar: 'الخط الزمني', icon: CalendarRange }, { to: '/planning', en: 'Smart planning', ar: 'التخطيط الذكي', icon: CalendarCheck }, { to: '/review', en: 'Weekly review', ar: 'المراجعة الأسبوعية', icon: ClipboardCheck }] },
  { en: 'Progress', ar: 'التقدم', items: [{ to: '/goals', en: 'Goals', ar: 'الأهداف', icon: Flag }, { to: '/habits', en: 'Habits & routines', ar: 'العادات والروتين', icon: Heart }, { to: '/projects', en: 'Projects', ar: 'المشاريع', icon: Target }, { to: '/analytics', en: 'Insights', ar: 'التحليلات', icon: BarChart3 }] },
  { en: 'More', ar: 'المزيد', items: [{ to: '/categories', en: 'Categories', ar: 'الفئات', icon: Tags }, { to: '/discover', en: 'Discover', ar: 'اكتشف', icon: Compass }, { to: '/updates', en: 'What’s new', ar: 'ما الجديد', icon: Gift }, { to: '/settings', en: 'Settings', ar: 'الإعدادات', icon: Settings }] },
]

export default function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { language, setLanguage } = useLanguage(), theme = useTheme(), auth = useAuth(), installer = useInstallPrompt(), ar = language === 'ar'
  const [signOutError, setSignOutError] = useState('')
  const save = (data: object) => { void api('/api/settings', 'PUT', data).catch(() => {}) }
  return <>
    {open && <button className="sidebar-backdrop" onClick={onClose} aria-label={ar ? 'إغلاق القائمة' : 'Close menu'} />}
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="brand">LifeOS<span>◈</span><button className="mobile-close icon-button" onClick={onClose} aria-label={ar ? 'إغلاق' : 'Close'}><X size={20} /></button></div>
      {groups.map(group => <nav key={group.en || 'main'} aria-label={group.en ? (ar ? group.ar : group.en) : (ar ? 'الرئيسية' : 'Main')}>
        {group.en && <p className="nav-group">{ar ? group.ar : group.en}</p>}
        {group.items.map(({ to, en, ar: label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} data-tour={to === '/' ? 'nav-today' : `nav${to.replace(/\//g, '-')}`} onClick={onClose} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>{({ isActive }) => <>{isActive && <m.span layoutId="nav-active" className="nav-active" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}<Icon size={19} /><span>{ar ? label : en}</span><NewBadge to={to} /></>}</NavLink>)}
      </nav>)}
      {installer.canInstall ? <button className="install-button" onClick={() => void installer.install()}><Download size={17} />{ar ? 'تثبيت التطبيق' : 'Install app'}</button> : !installer.installed && <InstallLink className="install-button" />}
      <ErrorMessage error={signOutError} />
      <div className="sidebar-prefs">
        <button type="button" className="icon-button" aria-label={ar ? 'English' : 'العربية'} onClick={() => { const next = ar ? 'en' : 'ar'; setLanguage(next); save({ language: next }) }}><Languages size={17} /><span>{ar ? 'EN' : 'ع'}</span></button>
        <button type="button" className="icon-button" aria-label={ar ? 'تغيير المظهر' : 'Change theme'} onClick={() => { const next = theme.resolvedTheme === 'dark' ? 'light' : 'dark'; theme.setTheme(next); save({ theme: next }) }}>{theme.resolvedTheme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button>
        <button type="button" className="icon-button" aria-label={ar ? 'تسجيل الخروج' : 'Sign out'} onClick={() => { setSignOutError(''); void signOutKeepingQueue(count => ar ? `سيُحذف ${count} تغيير محفوظ على هذا الجهاز. هل تريد تسجيل الخروج؟` : `${count} change(s) kept on this device will be deleted. Sign out anyway?`, auth.logout).catch(e => setSignOutError((e as Error).message)) }}><LogOut size={17} /></button>
      </div>
    </aside>
  </>
}
