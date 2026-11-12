import { accountZone } from '../../lib/accountDay'
import { typedTimesShifted } from '../../lib/zoneShift'
import { useText } from '../../lib/i18n'

/**
 * A quiet line under a form's date-and-time fields saying which clock they are on. Typed times mean the ACCOUNT's timezone (the one
 * the calendar, the list badges and the server use); when this device is in a zone with another offset it says so, so the difference
 * is never silent. Nothing is shown when the two zones read the same.
 */
export function ZoneNote({ id }: { id?: string }) {
  const t = useText(), zone = accountZone()
  if (!zone || !typedTimesShifted()) return null
  return <small id={id} className="muted zone-note full">{t('Times are in', 'الأوقات بتوقيت', 'Tijden in')} <bdi dir="ltr">{zone}</bdi></small>
}
