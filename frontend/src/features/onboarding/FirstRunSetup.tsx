import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, ApiError } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { useLanguage, type Language } from '../../contexts/LanguageContext'
import { Dialog, ErrorMessage } from '../../components/ui/Shared'
import { DateTimeField } from '../../components/ui/DateTimePicker'
import { setAccountZone } from '../../lib/accountDay'
import { setCalendarPrefs, weekdayOrder } from '../../lib/weekStart'
import { setPrayerPrefs } from '../../lib/prayerStore'
import { setUiPrefs } from '../../lib/uiPrefs'
import { methodForCountry } from '../settings/prayerLogic'
import type { City } from '../settings/prayerCities'
import { defaultWorkDays, setupDraft, type Settings, type SetupFields } from './setupDraft'

/** The step that shows each field, so a refusal from the server opens the step where it can be fixed. */
const STEP_OF: Record<string, number> = { language: 0, timezone: 0, week_start: 1, work_days: 1, work_start: 1, work_end: 1, calendar_system: 2, prayer_enabled: 2, prayer_lat: 2, prayer_lng: 2, prayer_method: 2 }
const zones = () => { try { return Intl.supportedValuesOf('timeZone') } catch { return [] } }

/**
 * The first-run setup: three short, skippable steps (basics, work week, extras) shown once to a new account, saved in one request.
 * Escape and × ask first, in the dialog itself; «Skip setup» skips at once. Either way the setup is marked done and never shows again.
 */
export default function FirstRunSetup() {
  const t = useText(), lang = useLanguage(), toast = useToast(), navigate = useNavigate(), id = useId()
  const [draft, setDraft] = useState<SetupFields | null>(null), [step, setStep] = useState(0), [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false)
  const [daysTouched, setDaysTouched] = useState(false), [cities, setCities] = useState<City[]>([]), [now, setNow] = useState(() => Date.now())
  const heading = useRef<HTMLHeadingElement>(null), keep = useRef<HTMLButtonElement>(null), startLanguage = useRef(lang.language)
  const finished = useRef(false), [hidden, setHidden] = useState(false)

  useEffect(() => {
    let live = true
    api<Settings>('/api/settings').then(s => { if (live && s.onboarding === 'pending') setDraft(setupDraft(s, lang.language)) }).catch(() => {})
    return () => { live = false }
    // Read once: the language chosen here changes the UI, which must not reload the settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { let live = true; void import('../settings/prayerCities').then(m => { if (live) setCities(m.CITIES) }); return () => { live = false } }, [])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer) }, [])
  const ready = draft !== null
  // Each step's heading takes focus, so a keyboard or screen-reader user starts reading at the new step.
  useEffect(() => { if (ready && !confirming) heading.current?.focus() }, [ready, step, confirming])
  useEffect(() => { if (confirming) keep.current?.focus() }, [confirming])
  // A browser may close a modal dialog on a second Escape without asking: open it again and keep asking.
  useEffect(() => {
    const dialog = heading.current?.closest('dialog')
    if (!dialog) return
    const reopen = () => { if (!finished.current && dialog.isConnected) { try { dialog.showModal() } catch { /* already open */ } setConfirming(true) } }
    dialog.addEventListener('close', reopen)
    return () => dialog.removeEventListener('close', reopen)
  }, [ready])

  if (!draft || hidden) return null
  const set = (patch: Partial<SetupFields>) => { setDraft({ ...draft, ...patch }); setErrors(e => { const next = { ...e }; Object.keys(patch).forEach(k => delete next[k]); return next }) }
  const field = (name: string) => errors[name] ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-${name}` } : {}
  const message = (name: string) => errors[name] ? <small className="error" role="alert" id={`${id}-${name}`}>{errors[name]}</small> : null
  const dayName = (d: number, weekday: 'long' | 'short') => new Date(2026, 0, 4 + d).toLocaleDateString(lang.language, { weekday })
  let localTime = ''
  try { localTime = new Date(now).toLocaleString(lang.language, { timeZone: draft.timezone, weekday: 'long', hour: '2-digit', minute: '2-digit' }) } catch { localTime = '' }

  /** The checks the server would make, in the person's language, for the fields of one step. */
  const check = (which: number) => {
    const found: Record<string, string> = {}
    if (which === 0 && !localTime) found.timezone = t('Choose a time zone from the list.', 'اختر منطقة زمنية من القائمة.', 'Kies een tijdzone uit de lijst.')
    if (which === 1 && draft.work_days.length === 0) found.work_days = t('Choose at least one working day.', 'اختر يوم عمل واحدًا على الأقل.', 'Kies minstens één werkdag.')
    if (which === 1 && draft.work_end <= draft.work_start) found.work_end = t('Work must end after it starts.', 'يجب أن ينتهي العمل بعد بدايته.', 'Het werk moet eindigen na het begin.')
    if (which === 2 && draft.prayer_enabled && (draft.prayer_lat == null || draft.prayer_lng == null)) found.prayer_lat = t('Choose a city for the prayer times.', 'اختر مدينة لأوقات الصلاة.', 'Kies een plaats voor de gebedstijden.')
    setErrors(found)
    return Object.keys(found).length === 0
  }
  const go = (to: number) => { setError(''); setStep(to) }
  const close = (saved: Record<string, unknown>) => {
    finished.current = true
    setUiPrefs(saved); setCalendarPrefs(saved); setPrayerPrefs(saved); setAccountZone(typeof saved.timezone === 'string' ? saved.timezone : undefined)
    setHidden(true)
  }
  const skip = async () => {
    setBusy(true); setError('')
    try {
      // A language chosen here already changed the screen; keep it rather than switch back on the next visit.
      close(await api<Record<string, unknown>>('/api/settings', 'PUT', { onboarding: 'done', ...(draft.language !== startLanguage.current ? { language: draft.language } : {}) }))
    } catch (e) { setConfirming(false); setError((e as Error).message) } finally { setBusy(false) }
  }
  const finish = async (to = '/') => {
    if (![0, 1, 2].every(s => check(s) || (setStep(s), false))) return
    setBusy(true); setError('')
    try {
      const saved = await api<Record<string, unknown>>('/api/settings', 'PUT', { ...draft, work_days: [...draft.work_days].sort((a, b) => a - b), onboarding: 'done' })
      close(saved)
      navigate(to)
      toast(t('Welcome to LifeOS. You are all set.', 'مرحبًا بك في LifeOS. كل شيء جاهز.', 'Welkom bij LifeOS. Alles staat klaar.'), 'success')
    } catch (e) {
      const fields = e instanceof ApiError ? Object.entries(e.errors ?? {}).map(([k, v]) => [k.split('.')[0], v[0]] as const).filter(([k]) => k in STEP_OF) : []
      if (fields.length) { setErrors(Object.fromEntries(fields)); setStep(Math.min(...fields.map(([k]) => STEP_OF[k]))) }
      else setError((e as Error).message)
    } finally { setBusy(false) }
  }

  const titles = [t('Your basics', 'الأساسيات', 'De basis'), t('Your work week', 'أسبوع عملك', 'Je werkweek'), t('Optional extras', 'إضافات اختيارية', 'Optionele extra’s')]
  const steps: ReactNode[] = [
    <>
      <label>{t('Language', 'اللغة', 'Taal')}<select value={draft.language} onChange={e => { const next = e.target.value as Language; set({ language: next }); lang.setLanguage(next) }}><option value="en">English</option><option value="ar">العربية</option><option value="nl">Nederlands</option></select></label>
      <label>{t('Time zone', 'المنطقة الزمنية', 'Tijdzone')}<input value={draft.timezone} list={`${id}-zones`} required autoComplete="off" spellCheck={false} dir="ltr" onChange={e => set({ timezone: e.target.value })} {...field('timezone')} aria-describedby={[errors.timezone && `${id}-timezone`, localTime && `${id}-now`].filter(Boolean).join(' ') || undefined} /><datalist id={`${id}-zones`}>{zones().map(z => <option key={z} value={z} />)}</datalist>{message('timezone')}</label>
      {localTime && <p className="muted" id={`${id}-now`}>{t('Your local time there:', 'الوقت المحلي هناك:', 'Je lokale tijd daar:')} <strong>{localTime}</strong>. {t('If this is not right, choose another time zone.', 'إن لم يكن صحيحًا فاختر منطقة زمنية أخرى.', 'Klopt dit niet? Kies dan een andere tijdzone.')}</p>}
    </>,
    <>
      <label>{t('Week starts on', 'يبدأ الأسبوع يوم', 'Week begint op')}<select value={draft.week_start} {...field('week_start')} onChange={e => { const ws = Number(e.target.value); set({ week_start: ws, ...(daysTouched ? {} : { work_days: defaultWorkDays(ws) }) }) }}>{[6, 0, 1].map(d => <option key={d} value={d}>{dayName(d, 'long')}</option>)}</select>{message('week_start')}</label>
      <fieldset><legend>{t('Working days', 'أيام العمل', 'Werkdagen')}</legend><div className="weekday-picker">{weekdayOrder(draft.week_start).map(day => <label key={day}><input type="checkbox" checked={draft.work_days.includes(day)} onChange={e => { setDaysTouched(true); set({ work_days: e.target.checked ? [...draft.work_days, day] : draft.work_days.filter(d => d !== day) }) }} />{dayName(day, 'short')}</label>)}</div>{message('work_days')}</fieldset>
      <div className="form-grid">
        <label>{t('Work starts', 'بداية العمل', 'Werk begint')}<DateTimeField kind="time" required value={draft.work_start} onChange={v => set({ work_start: v })} describedBy={errors.work_start ? `${id}-work_start` : undefined} />{message('work_start')}</label>
        <label>{t('Work ends', 'نهاية العمل', 'Werk eindigt')}<DateTimeField kind="time" required value={draft.work_end} onChange={v => set({ work_end: v })} describedBy={errors.work_end ? `${id}-work_end` : undefined} />{message('work_end')}</label>
      </div>
    </>,
    <>
      <label className="inline"><input type="checkbox" checked={draft.calendar_system === 'hijri'} onChange={e => set({ calendar_system: e.target.checked ? 'hijri' : 'gregorian' })} />{t('Show Hijri dates beside the Gregorian ones', 'إظهار التاريخ الهجري بجانب الميلادي', 'Toon Hijri-datums naast de Gregoriaanse')}</label>
      <fieldset><legend>{t('Prayer times', 'أوقات الصلاة', 'Gebedstijden')}</legend>
        <label className="inline"><input type="checkbox" checked={draft.prayer_enabled} onChange={e => set({ prayer_enabled: e.target.checked })} />{t('Show prayer times and keep planned work clear of them', 'إظهار أوقات الصلاة وإبقاء العمل المخطط بعيدًا عنها', 'Toon gebedstijden en houd ingepland werk ervan vrij')}</label>
        <label>{t('City', 'المدينة', 'Plaats')}<select value={cities.find(c => c.lat === draft.prayer_lat && c.lng === draft.prayer_lng)?.id ?? ''} {...field('prayer_lat')} onChange={e => { const city = cities.find(c => c.id === e.target.value); set(city ? { prayer_lat: city.lat, prayer_lng: city.lng, prayer_method: methodForCountry(city.country) } : { prayer_lat: null, prayer_lng: null }) }}><option value="">{t('Choose a city', 'اختر مدينة', 'Kies een plaats')}</option>{cities.map(c => <option key={c.id} value={c.id}>{lang.language === 'ar' ? c.names[1] : lang.language === 'nl' ? c.names[2] : c.names[0]}</option>)}</select>{message('prayer_lat') ?? message('prayer_lng') ?? message('prayer_enabled')}</label>
        <p className="muted">{t('Your location, the calculation method and Ramadan hours can be changed later in Settings.', 'يمكنك لاحقًا تغيير الموقع وطريقة الحساب وساعات رمضان من الإعدادات.', 'Je locatie, de berekeningsmethode en de Ramadan-uren kun je later wijzigen in Instellingen.')}</p>
      </fieldset>
      <p className="muted">{t('Using Google or Outlook Calendar?', 'تستخدم تقويم Google أو Outlook؟', 'Gebruik je Google of Outlook Agenda?')} <Link to="/settings/integrations" onClick={e => { e.preventDefault(); void finish('/settings/integrations') }}>{t('Finish and connect a calendar in Settings', 'أنهِ الإعداد واربط تقويمًا من الإعدادات', 'Rond af en koppel een agenda in Instellingen')}</Link></p>
    </>,
  ]

  return <Dialog title={titles[step]} headingRef={heading} onClose={() => setConfirming(true)} onDismiss={() => { if (!busy) setConfirming(c => !c) }}>
    <p className="muted">{t(`Step ${step + 1} of 3`, `الخطوة ${step + 1} من 3`, `Stap ${step + 1} van 3`)}</p>
    <ErrorMessage error={error} />
    {confirming ? <div role="group" aria-labelledby={`${id}-ask`}>
      <p id={`${id}-ask`}><strong>{t('Skip the setup?', 'تخطي الإعداد؟', 'De instelling overslaan?')}</strong> {t('LifeOS keeps its defaults. You can change everything later in Settings.', 'سيحتفظ LifeOS بالإعدادات الافتراضية. يمكنك تغيير كل شيء لاحقًا من الإعدادات.', 'LifeOS houdt de standaardinstellingen. Je kunt alles later wijzigen in Instellingen.')}</p>
      <div className="row"><button type="button" ref={keep} className="primary" onClick={() => setConfirming(false)}>{t('Keep setting up', 'متابعة الإعداد', 'Verder instellen')}</button><button type="button" className="quiet" disabled={busy} onClick={() => void skip()}>{t('Skip setup', 'تخطي الإعداد', 'Instelling overslaan')}</button></div>
    </div> : <form noValidate onSubmit={e => { e.preventDefault(); if (step < 2) { if (check(step)) go(step + 1) } else void finish() }}>
      {steps[step]}
      <div className="row">
        <button type="button" className="quiet" disabled={busy} onClick={() => void skip()}>{t('Skip setup', 'تخطي الإعداد', 'Instelling overslaan')}</button>
        <div className="toolbar">
          {step > 0 && <button type="button" className="quiet" disabled={busy} onClick={() => go(step - 1)}>{t('Back', 'السابق', 'Terug')}</button>}
          <button className="primary" disabled={busy}>{step < 2 ? t('Next', 'التالي', 'Volgende') : t('Finish', 'إنهاء', 'Afronden')}</button>
        </div>
      </div>
    </form>}
  </Dialog>
}
