import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { CalendarDays, Globe } from 'lucide-react'
import type { TodayData } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { minutesLabel } from '../../lib/dates'
import { Skeleton } from '../../components/ui/Shared'
import { arcPath, dayAngle, isValidZone, polar } from '../../lib/dial'

const SIZE = 220, C = SIZE / 2

type Item = { id: string; title: string; starts_at: string; ends_at: string; kind: 'fixed' | 'flexible' | 'slot'; source: string }

/**
 * Today as a 24-hour dial: commitments (LifeOS and connected calendars), free focus slots, your work/study/personal
 * windows and a live "now" hand. Arcs and the list are linked: hover or focus either to highlight both.
 */
export function DayDial({ data }: { data: TodayData | null }) {
  const t = useText(), { language } = useLanguage(), ar = language === 'ar'
  const [now, setNow] = useState(() => Date.now()), [active, setActive] = useState<string | null>(null)
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(id) }, [])
  if (!data) return <section className="panel"><Skeleton height={220} /></section>
  // Anchor to the user's day (server timezone setting); fall back to the browser's day for older responses.
  const start = data.day_start ? Date.parse(data.day_start) : new Date(now).setHours(0, 0, 0, 0)
  // Labels use the account's timezone — the same one the dial is drawn in — so a browser in another zone stays consistent.
  const timeZone = data.timezone && isValidZone(data.timezone) ? data.timezone : undefined
  const time = (iso: string | number) => new Date(iso).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', timeZone })
  const events: Item[] = data.timeline.filter(e => !e.all_day).map(e => ({ ...e, kind: e.kind === 'fixed' ? 'fixed' : 'flexible' }))
  const slots: Item[] = data.focus_time.slots.map(s => ({ id: `slot-${s.starts_at}`, title: t('Free for focus', 'وقت متاح للتركيز'), starts_at: s.starts_at, ends_at: s.ends_at, kind: 'slot', source: 'lifeos' }))
  const items = [...events, ...slots].sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  const focused = items.find(i => i.id === active)
  const remaining = events.filter(e => new Date(e.ends_at).getTime() > now).length
  const nowAngle = dayAngle(now, start)
  const label = (i: Item) => `${i.title}, ${time(i.starts_at)}–${time(i.ends_at)}${i.source !== 'lifeos' ? ` (${i.source})` : ''}`

  return <section className="panel reveal day-dial-panel" aria-labelledby="day-dial-title">
    <header className="row"><h2 id="day-dial-title">{t('Today, in perspective', 'نظرة على اليوم')}</h2><Link to="/calendar" className="icon-button" aria-label={t('Open calendar', 'فتح التقويم')}><CalendarDays size={19} /></Link></header>
    <div className="day-dial">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="group" aria-label={t('24-hour view of today', 'عرض اليوم على مدار ٢٤ ساعة')}>
        <circle className="dial-track" cx={C} cy={C} r={86} strokeWidth={12} />
        {Object.entries(data.windows ?? {}).map(([area, w]) => <path key={area} className="dial-window" d={arcPath(101, dayAngle(w.start, start), dayAngle(w.end, start))} strokeWidth={4}><title>{area}</title></path>)}
        {[0, 6, 12, 18].map(h => { const [x, y] = polar(70, h * 15); return <text key={h} className="dial-hour" x={x} y={y} textAnchor="middle" dominantBaseline="middle">{String(h).padStart(2, '0')}</text> })}
        {slots.map(s => <path key={s.id} className={`dial-arc slot ${active === s.id ? 'active' : ''}`} d={arcPath(86, dayAngle(s.starts_at, start), dayAngle(s.ends_at, start))} strokeWidth={6} tabIndex={0} aria-label={label(s)} onMouseEnter={() => setActive(s.id)} onFocus={() => setActive(s.id)} onMouseLeave={() => setActive(null)} onBlur={() => setActive(null)} />)}
        {events.map(e => <path key={e.id} className={`dial-arc kind-${e.kind} ${e.source !== 'lifeos' ? 'source-external' : ''} ${active === e.id ? 'active' : ''}`} d={arcPath(86, dayAngle(e.starts_at, start), dayAngle(e.ends_at, start))} strokeWidth={12} tabIndex={0} aria-label={label(e)} onMouseEnter={() => setActive(e.id)} onFocus={() => setActive(e.id)} onMouseLeave={() => setActive(null)} onBlur={() => setActive(null)} />)}
        <line className="dial-now" x1={polar(46, nowAngle)[0]} y1={polar(46, nowAngle)[1]} x2={polar(106, nowAngle)[0]} y2={polar(106, nowAngle)[1]} />
        <foreignObject x={C - 58} y={C - 30} width={116} height={60}>
          <div className="dial-center" style={{ display: 'grid', placeItems: 'center', height: '100%', textAlign: 'center', fontSize: 11, lineHeight: 1.3 }}>
            {focused ? <><strong style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 100, whiteSpace: 'nowrap' }}>{focused.title}</strong><span className="muted">{time(focused.starts_at)}–{time(focused.ends_at)}</span></>
              : <><strong style={{ whiteSpace: 'nowrap', fontSize: 17 }}>{time(now)}</strong><span className="muted">{t(`${remaining} still ahead`, `${remaining} متبقية`)}</span></>}
          </div>
        </foreignObject>
      </svg>
      {items.length === 0 ? <p className="muted">{t('Nothing booked today, and no free slot left in your windows.', 'لا شيء محجوز اليوم، ولا فترة متاحة متبقية ضمن أوقاتك.')}</p> : <ul>{items.map(i => <li key={i.id}>
        <button type="button" className={active === i.id ? 'active' : ''} onMouseEnter={() => setActive(i.id)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(i.id)} onBlur={() => setActive(null)}>
          <i style={{ background: i.kind === 'slot' ? 'var(--color-success)' : i.source !== 'lifeos' ? '#8b5cf6' : i.kind === 'fixed' ? 'var(--color-primary)' : '#14b8c4' }} aria-hidden="true" />
          <time>{time(i.starts_at)}–{time(i.ends_at)}</time>
          <span>{i.title}{i.kind === 'slot' && <small className="muted"> · {minutesLabel(Math.round((new Date(i.ends_at).getTime() - new Date(i.starts_at).getTime()) / 60000), ar)}</small>}</span>
          {i.source !== 'lifeos' && <small className="source-badge"><Globe size={10} /> {i.source === 'google' ? 'Google' : i.source === 'outlook' ? 'Outlook' : i.source}</small>}
        </button>
      </li>)}</ul>}
    </div>
  </section>
}
