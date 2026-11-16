import { useEffect, useId, useState } from 'react'
import { LocateFixed } from 'lucide-react'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { DateTimeField } from '../../components/ui/DateTimePicker'
import { methodForCountry, parseCoord, type Method } from './prayerLogic'
import type { City } from './prayerCities'

/** The prayer and Ramadan fields of the preferences, exactly as /api/settings stores them. */
export type PrayerFields = {
  prayer_enabled: boolean; prayer_lat: number | null; prayer_lng: number | null; prayer_method: Method; prayer_asr: 'standard' | 'hanafi'
  prayer_before: number; prayer_after: number; jumuah_after: number; ramadan_mode: 'off' | 'auto' | 'on'; ramadan_work_start: string; ramadan_work_end: string; iftar_minutes: number
}

const METHODS: [Method, string, string, string][] = [
  ['umm_al_qura', 'Umm al-Qura (Makkah)', 'أم القرى (مكة المكرمة)', 'Umm al-Qura (Mekka)'], ['muslim_world_league', 'Muslim World League', 'رابطة العالم الإسلامي', 'Moslimwereldliga'],
  ['egyptian', 'Egyptian General Authority', 'الهيئة المصرية العامة للمساحة', 'Egyptische autoriteit'], ['karachi', 'University of Islamic Sciences, Karachi', 'جامعة العلوم الإسلامية بكراتشي', 'Universiteit voor Islamitische Wetenschappen, Karachi'],
  ['north_america', 'ISNA (North America)', 'الجمعية الإسلامية لأمريكا الشمالية', 'ISNA (Noord-Amerika)'], ['kuwait', 'Kuwait', 'الكويت', 'Koeweit'], ['qatar', 'Qatar', 'قطر', 'Qatar'], ['turkey', 'Turkey (Diyanet)', 'تركيا (الديانة)', 'Turkije (Diyanet)'],
]

/**
 * Settings: «Prayer times & Ramadan». A controlled part of the preferences form (the parent saves it with the other preferences and hands back
 * the server's field errors). The place is chosen from a short city list, from the device on a click, or typed; it only ever goes to /api/settings.
 */
export default function PrayerSettings({ prefs, onChange, errors }: { prefs: PrayerFields; onChange: (patch: Partial<PrayerFields>) => void; errors: Record<string, string[]> }) {
  const t = useText(), { language } = useLanguage(), id = useId()
  const [cities, setCities] = useState<City[]>([]), [lat, setLat] = useState(prefs.prayer_lat == null ? '' : String(prefs.prayer_lat)), [lng, setLng] = useState(prefs.prayer_lng == null ? '' : String(prefs.prayer_lng))
  const [locating, setLocating] = useState(false), [locateNote, setLocateNote] = useState('')
  useEffect(() => { let live = true; void import('./prayerCities').then(m => { if (live) setCities(m.CITIES) }); return () => { live = false } }, [])
  const place = (la: number | null, ln: number | null) => { setLat(la == null ? '' : String(la)); setLng(ln == null ? '' : String(ln)); onChange({ prayer_lat: la, prayer_lng: ln }) }
  const pickCity = (cityId: string) => {
    const city = cities.find(c => c.id === cityId); if (!city) return
    place(city.lat, city.lng); onChange({ prayer_method: methodForCountry(city.country) }); setLocateNote('')
  }
  const here = () => {
    setLocateNote('')
    if (!('geolocation' in navigator)) { setLocateNote(t('This device cannot share its location. Choose a city or type the coordinates.', 'لا يمكن لهذا الجهاز مشاركة موقعه. اختر مدينة أو اكتب الإحداثيات.', 'Dit apparaat kan zijn locatie niet delen. Kies een plaats of typ de coördinaten.')); return }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      p => { setLocating(false); place(Math.round(p.coords.latitude * 1e4) / 1e4, Math.round(p.coords.longitude * 1e4) / 1e4); setLocateNote(t('Location found. Save to keep it.', 'تم تحديد الموقع. احفظ للاحتفاظ به.', 'Locatie gevonden. Sla op om haar te bewaren.')) },
      e => { setLocating(false); setLocateNote(e.code === 1 ? t('Location access was denied. Choose a city or type the coordinates instead.', 'تم رفض الوصول إلى الموقع. اختر مدينة أو اكتب الإحداثيات بدلًا من ذلك.', 'Toegang tot de locatie is geweigerd. Kies een plaats of typ de coördinaten.') : t('Your location could not be determined. Choose a city or type the coordinates instead.', 'تعذر تحديد موقعك. اختر مدينة أو اكتب الإحداثيات بدلًا من ذلك.', 'Je locatie kon niet worden bepaald. Kies een plaats of typ de coördinaten.')) },
      { timeout: 10_000, maximumAge: 600_000 })
  }
  const typed = (which: 'lat' | 'lng', text: string) => {
    const la = which === 'lat' ? text : lat, ln = which === 'lng' ? text : lng
    if (which === 'lat') setLat(text); else setLng(text)
    onChange({ prayer_lat: parseCoord(la, 90).value, prayer_lng: parseCoord(ln, 180).value })
  }
  const latBad = parseCoord(lat, 90).error, lngBad = parseCoord(lng, 180).error
  const chosen = cities.find(c => c.lat === prefs.prayer_lat && c.lng === prefs.prayer_lng)?.id ?? ''
  const err = (name: string, own?: string) => { const msg = errors[name]?.[0] ?? own; return msg ? <small className="error full" role="alert" id={`${id}-${name}`}>{msg}</small> : null }
  const bad = (name: string, own?: boolean) => (own || errors[name]) ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-${name}` } : {}
  const num = (name: 'prayer_before' | 'prayer_after' | 'jumuah_after' | 'iftar_minutes', label: string, min: number, max: number) =>
    <label>{label}<input type="number" inputMode="numeric" min={min} max={max} value={prefs[name]} onChange={e => onChange({ [name]: Number(e.target.value) })} {...bad(name)} />{err(name)}</label>
  const ramadan = prefs.ramadan_mode !== 'off'
  return <fieldset className="full prayer-settings"><legend>{t('Prayer times & Ramadan', 'أوقات الصلاة ورمضان', 'Gebedstijden en Ramadan')}</legend>
    <div className="form-grid">
      <label className="inline full"><input type="checkbox" checked={prefs.prayer_enabled} onChange={e => onChange({ prayer_enabled: e.target.checked })} {...bad('prayer_enabled')} />{t('Show prayer times and keep planned work clear of them', 'إظهار أوقات الصلاة وإبقاء العمل المخطط بعيدًا عنها', 'Toon gebedstijden en houd ingepland werk ervan vrij')}</label>
      {err('prayer_enabled')}
      <label>{t('City', 'المدينة', 'Plaats')}<select value={chosen} onChange={e => pickCity(e.target.value)}><option value="">{t('Choose a city', 'اختر مدينة', 'Kies een plaats')}</option>{cities.map(c => <option key={c.id} value={c.id}>{language === 'ar' ? c.names[1] : language === 'nl' ? c.names[2] : c.names[0]}</option>)}</select></label>
      <div className="prayer-here"><button type="button" className="quiet" disabled={locating} onClick={here}><LocateFixed size={16} aria-hidden="true" />{t('Use my current location', 'استخدم موقعي الحالي', 'Gebruik mijn huidige locatie')}</button>
        <small className="muted" role="status">{locateNote}</small></div>
      <label>{t('Latitude (−90 to 90)', 'خط العرض (−90 إلى 90)', 'Breedtegraad (−90 tot 90)')}<input inputMode="decimal" dir="ltr" value={lat} onChange={e => typed('lat', e.target.value)} {...bad('prayer_lat', latBad)} />{err('prayer_lat', latBad ? t('Enter a number between −90 and 90.', 'أدخل رقمًا بين −90 و90.', 'Voer een getal tussen −90 en 90 in.') : undefined)}</label>
      <label>{t('Longitude (−180 to 180)', 'خط الطول (−180 إلى 180)', 'Lengtegraad (−180 tot 180)')}<input inputMode="decimal" dir="ltr" value={lng} onChange={e => typed('lng', e.target.value)} {...bad('prayer_lng', lngBad)} />{err('prayer_lng', lngBad ? t('Enter a number between −180 and 180.', 'أدخل رقمًا بين −180 و180.', 'Voer een getal tussen −180 en 180 in.') : undefined)}</label>
      <label>{t('Calculation method', 'طريقة الحساب', 'Berekeningsmethode')}<select value={prefs.prayer_method} onChange={e => onChange({ prayer_method: e.target.value as Method })} {...bad('prayer_method')}>{METHODS.map(([v, en, ar, nl]) => <option key={v} value={v}>{t(en, ar, nl)}</option>)}</select>{err('prayer_method')}</label>
      <label>{t('Asr calculation', 'حساب العصر', 'Asr-berekening')}<select value={prefs.prayer_asr} onChange={e => onChange({ prayer_asr: e.target.value as PrayerFields['prayer_asr'] })}><option value="standard">{t('Standard (Shafi’i, Maliki, Hanbali)', 'القياسي (الشافعي والمالكي والحنبلي)', 'Standaard (Shafi’i, Maliki, Hanbali)')}</option><option value="hanafi">{t('Hanafi', 'الحنفي', 'Hanafi')}</option></select></label>
      {num('prayer_before', t('Minutes kept clear before each prayer', 'دقائق قبل كل صلاة', 'Minuten vrij vóór elk gebed'), 0, 60)}
      {num('prayer_after', t('Minutes kept clear after each prayer', 'دقائق بعد كل صلاة', 'Minuten vrij na elk gebed'), 0, 90)}
      {num('jumuah_after', t('Jumu’ah window (minutes after Dhuhr on Fridays)', 'مدة صلاة الجمعة (دقائق بعد الظهر)', 'Jumu’ah-venster (minuten na Dohr op vrijdag)'), 30, 180)}
      <label>{t('Ramadan mode', 'وضع رمضان', 'Ramadanmodus')}<select value={prefs.ramadan_mode} onChange={e => onChange({ ramadan_mode: e.target.value as PrayerFields['ramadan_mode'] })}><option value="off">{t('Off', 'متوقف', 'Uit')}</option><option value="auto">{t('Automatic (follows the Hijri month)', 'تلقائي (يتبع الشهر الهجري)', 'Automatisch (volgt de Hijri-maand)')}</option><option value="on">{t('On', 'مفعّل', 'Aan')}</option></select></label>
      {ramadan && <>
        <label>{t('Ramadan work starts', 'بداية العمل في رمضان', 'Werk begint in Ramadan')}<DateTimeField kind="time" required value={prefs.ramadan_work_start} onChange={v => onChange({ ramadan_work_start: v })} /></label>
        <label>{t('Ramadan work ends', 'نهاية العمل في رمضان', 'Werk eindigt in Ramadan')}<DateTimeField kind="time" required value={prefs.ramadan_work_end} onChange={v => onChange({ ramadan_work_end: v })} /></label>
        {num('iftar_minutes', t('Minutes kept clear for iftar', 'دقائق مخصصة للإفطار', 'Minuten vrij voor iftar'), 15, 120)}</>}
    </div>
    <p className="muted">{t('Times are calculated and can differ by a minute or two from your local mosque timetable. Your coordinates are used only to calculate them and are saved with your settings.', 'الأوقات محسوبة وقد تختلف بدقيقة أو دقيقتين عن جدول المسجد في منطقتك. تُستخدم إحداثياتك لحسابها فقط وتُحفظ مع إعداداتك.', 'De tijden worden berekend en kunnen een minuut of twee afwijken van het rooster van je plaatselijke moskee. Je coördinaten worden alleen gebruikt om ze te berekenen en worden met je instellingen bewaard.')}</p>
  </fieldset>
}
