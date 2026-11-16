import { useEffect, useState } from 'react'
import { Moon } from 'lucide-react'
import { useText } from '../../lib/i18n'
import { accountDay } from '../../lib/accountDay'
import { formatClock } from '../../lib/clock'
import { nextPrayer, prayerLabel, untilWords, usePrayerRange } from '../../lib/prayer'
import { usePrayerPrefs } from '../../lib/prayerStore'

/**
 * Two quiet lines on Today, only for an account that turned prayer times on: the next prayer with the time left, and, on a day of Ramadan
 * (the setting's mode decides which days), the shortened work hours and the iftar time. Nothing is drawn while the times load or fail.
 */
export default function PrayerToday() {
  const t = useText(), prefs = usePrayerPrefs(), [now, setNow] = useState(() => new Date())
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(id) }, [])
  // Today and tomorrow: after Isha the next prayer is tomorrow's Fajr.
  const data = usePrayerRange(accountDay(now), 2)
  if (!data) return null
  const zone = { timeZone: data.timezone }, next = nextPrayer(data.days, now), today = data.days[0]
  return <div className="prayer-today">
    {next && <p className="muted small" data-testid="next-prayer">{t('Next prayer: ', 'الصلاة التالية: ', 'Volgend gebed: ')}<strong>{prayerLabel(next.key, t)}</strong> <bdi dir="ltr">{formatClock(next.at, zone)}</bdi>{' '}({t('in ', 'بعد ', 'over ')}{untilWords(next.minutes, t)})</p>}
    {today?.ramadan && <p className="muted small" data-testid="ramadan-note"><Moon size={14} aria-hidden="true" /> <strong>{t('Ramadan mode', 'وضع رمضان', 'Ramadanmodus')}</strong>{t(': work hours ', ': ساعات العمل ', ': werktijden ')}<bdi dir="ltr">{prefs.workStart}–{prefs.workEnd}</bdi>
      {today.iftar && <>{t(', iftar ', '، الإفطار ', ', iftar ')}<bdi dir="ltr">{formatClock(today.iftar.starts_at, zone)}</bdi></>}</p>}
  </div>
}
