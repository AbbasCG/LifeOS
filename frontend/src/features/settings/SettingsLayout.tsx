import { useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { SlidersHorizontal, ShieldCheck, CalendarSync, Bot, BellRing, Workflow, HeartPulse, BrainCircuit } from 'lucide-react'
import { useText } from '../../lib/i18n'
import { withTransition } from '../../lib/viewTransition'

export default function SettingsLayout() {
  const t = useText(), { pathname } = useLocation(), navigate = useNavigate()
  const tabs = [
    { to: '/settings', end: true, label: t('General', 'عام', 'Algemeen'), icon: SlidersHorizontal },
    { to: '/settings/security', label: t('Security', 'الأمان', 'Beveiliging'), icon: ShieldCheck },
    { to: '/settings/wellbeing', label: t('Wellbeing', 'الرفاه', 'Welzijn'), icon: HeartPulse },
    { to: '/settings/notifications', label: t('Notifications', 'الإشعارات', 'Meldingen'), icon: BellRing },
    { to: '/settings/integrations', label: t('Connected accounts', 'الحسابات المرتبطة', 'Gekoppelde accounts'), icon: CalendarSync },
    { to: '/settings/ai', label: t('AI Control Center', 'مركز الذكاء الاصطناعي', 'AI-controlecentrum'), icon: BrainCircuit },
    { to: '/settings/assistant', label: t('Assistant', 'المساعد', 'Assistent'), icon: Bot },
    { to: '/settings/automations', label: t('Automations', 'الأتمتة', 'Automatiseringen'), icon: Workflow },
  ]
  // General settings has its own visible heading; the other sections get one for screen readers and the outline.
  const nav = useRef<HTMLElement>(null)
  // Bring the active tab into view without moving focus; mark which edges still hide tabs so CSS can fade them.
  useEffect(() => {
    const el = nav.current; if (!el) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el.querySelector<HTMLElement>('a.active')?.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
    const mark = () => {
      const max = el.scrollWidth - el.clientWidth, pos = Math.abs(el.scrollLeft)
      el.toggleAttribute('data-fs', max > 2 && pos > 2); el.toggleAttribute('data-fe', max > 2 && pos < max - 2)
    }
    mark(); el.addEventListener('scroll', mark, { passive: true }); window.addEventListener('resize', mark)
    // Tab widths change with the language, so watch the strip and every tab.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(mark)
    observer?.observe(el); el.querySelectorAll('a').forEach(a => observer?.observe(a))
    return () => { el.removeEventListener('scroll', mark); window.removeEventListener('resize', mark); observer?.disconnect() }
  }, [pathname])
  const section = tabs.find(tab => tab.to !== '/settings' && pathname.startsWith(tab.to))
  return <div className="settings-hub">
    {section && <h1 className="sr-only">{t(`Settings: ${section.label}`, `الإعدادات: ${section.label}`, `Instellingen: ${section.label}`)}</h1>}
    <nav ref={nav} className="settings-tabs" aria-label={t('Settings sections', 'أقسام الإعدادات', 'Instellingensecties')}>
      {tabs.map(({ to, end, label, icon: Icon }) => <NavLink key={to} to={to} end={end} className={({ isActive }) => isActive ? 'active' : ''}
        onClick={e => {
          // A plain click on another tab cross-fades the pane and slides the indicator (View Transitions); anything else is the browser's.
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || pathname === to) return
          e.preventDefault(); withTransition(() => flushSync(() => navigate(to)))
        }}>{({ isActive }) => <><Icon size={17} />{label}{isActive && <span className="tab-ind" aria-hidden="true" />}</>}</NavLink>)}
    </nav>
    <div className="settings-pane"><Outlet /></div>
  </div>
}
