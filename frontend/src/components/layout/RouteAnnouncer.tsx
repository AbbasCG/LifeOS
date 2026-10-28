import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'
import { useLanguage } from '../../contexts/LanguageContext'
import { announce, whenHeading } from '../../lib/announce'

/**
 * Single-page navigation is silent for screen readers, and the tab title never changed. After each page change
 * this names the page in the title and announces it. The first page is only titled: screen readers read it on load.
 */
export default function RouteAnnouncer() {
  const { pathname } = useLocation(), { language } = useLanguage()
  const last = useRef<string | null>(null)
  useEffect(() => whenHeading(heading => {
    // Today's heading is the date; its name is clearer.
    const name = pathname === '/' ? (language === 'ar' ? 'اليوم' : 'Today') : heading
    document.title = `${name} · LifeOS`
    if (last.current !== null && last.current !== pathname) announce(name)
    last.current = pathname
  }), [pathname, language])
  return null
}
