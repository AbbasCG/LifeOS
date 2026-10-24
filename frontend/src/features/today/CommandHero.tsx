import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { m } from 'motion/react'
import { Sparkles, ArrowUpRight } from 'lucide-react'
import type { TodayData } from '../../lib/api'
import { todayGuidance } from '../../lib/guidance'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { LivingOrb } from '../../components/orb/LivingOrb'

/**
 * The command center header: greeting, a one-line picture of the day, the most useful next move, and the living orb
 * filled to today's overall progress.
 */
export function CommandHero({ greeting, summary, today, actions }: { greeting: ReactNode; summary: string; today: TodayData | null; actions: ReactNode }) {
  const t = useText(), { language } = useLanguage(), ar = language === 'ar'
  const guidance = today ? todayGuidance(today) : null
  const overall = today?.progress.overall ?? 0
  const cta = guidance && (guidance.to.startsWith('#')
    ? <a className="quiet" href={guidance.to}>{ar ? guidance.ctaAr : guidance.ctaEn}</a>
    : <Link className="quiet" to={guidance.to}>{ar ? guidance.ctaAr : guidance.ctaEn}<ArrowUpRight size={15} className="flip-rtl" /></Link>)
  return <section className="command-hero panel" aria-label={t('Today', 'اليوم')}>
    <div>
      <p className="eyebrow">{new Date().toLocaleDateString(language, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      <h1>{greeting}</h1>
      <p className="muted">{summary}</p>
      {guidance && <m.div className={`hero-guidance tone-${guidance.tone}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 240, damping: 26, delay: 0.15 }} role="note">
        <Sparkles size={17} /><div><p>{ar ? guidance.ar : guidance.en}</p><div className="toolbar" style={{ marginTop: 8 }}>{cta}</div></div>
      </m.div>}
      <div className="toolbar" style={{ marginTop: 16 }}>{actions}</div>
    </div>
    <div className="hero-visual">
      <LivingOrb progress={overall / 100} mode={today?.period === 'evening' ? 'focus' : 'idle'} size={190} label={t(`Today’s progress: ${overall}% across tasks, focus and habits`, `تقدم اليوم: ${overall}٪ عبر المهام والتركيز والعادات`)} />
      <small>{t(`${overall}% of today`, `${overall}٪ من اليوم`)}</small>
    </div>
  </section>
}
