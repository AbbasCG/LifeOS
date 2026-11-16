import { test, expect, noHorizontalOverflow, pick, field } from './fixtures'
import { a11yViolations } from './axe'
import type { Page } from '@playwright/test'

/**
 * Prayer times and Ramadan mode are opt-in account settings. These tests set them through the API (and once through the Settings page),
 * look at Today, the calendar and the event form, and put the account's own values back in a `finally`. They never depend on today's
 * date or on the demo account being free: Today and the calendar are checked by their SHAPE, and the booking test uses a far-away Sunday.
 */
const KEYS = ['prayer_enabled', 'prayer_lat', 'prayer_lng', 'prayer_method', 'prayer_asr', 'prayer_before', 'prayer_after', 'jumuah_after', 'ramadan_mode', 'ramadan_work_start', 'ramadan_work_end', 'iftar_minutes', 'language'] as const
type Saved = Record<(typeof KEYS)[number], unknown>
const MAKKAH = { prayer_enabled: true, prayer_lat: 21.4225, prayer_lng: 39.8262, prayer_method: 'umm_al_qura', ramadan_mode: 'on' }

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body] as const)
}
const keep = async (page: Page): Promise<Saved> => { await page.goto('/settings'); const { body } = await call(page, 'GET', '/api/settings'); return Object.fromEntries(KEYS.map(k => [k, body[k]])) as Saved }
const restore = async (page: Page, saved: Saved) => { await page.goto('/settings'); expect((await call(page, 'PUT', '/api/settings', saved)).status).toBe(200) }
const setPrefs = async (page: Page, prefs: Record<string, unknown>) => { await page.goto('/settings'); const r = await call(page, 'PUT', '/api/settings', prefs); expect(r.status, JSON.stringify(r.body)).toBe(200) }
const saveButton = (page: Page) => page.getByRole('button', { name: /^(Save preferences|حفظ التفضيلات)$/ })

test('Today shows the next prayer and the Ramadan note, the calendar draws prayer bands, and turning it off removes all of it', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const saved = await keep(page)
  try {
    await setPrefs(page, { ...MAKKAH })
    await page.goto('/')
    await expect(page.getByTestId('next-prayer')).toHaveText(/^Next prayer: (Fajr|Dhuhr|Asr|Maghrib|Isha) \d\d:\d\d \(in (\d+ h )?\d+ min\)$/)
    await expect(page.getByTestId('ramadan-note')).toHaveText(/^\s*Ramadan mode: work hours 10:00–15:00, iftar \d\d:\d\d$/)

    // Calendar: one read for the whole week, bands in the day and week views, nothing in the month view.
    const reads: string[] = []
    page.on('request', r => { if (r.url().includes('/api/prayer-times')) reads.push(r.url()) })
    await page.addInitScript(() => localStorage.setItem('lifeos-calendar-view', 'week'))
    await page.goto('/calendar')
    const bands = page.locator('.prayer-band')
    await expect(bands.first()).toBeVisible()
    expect(await bands.count()).toBeGreaterThanOrEqual(5)
    expect(reads).toHaveLength(1)
    expect(new URL(reads[0]).searchParams.get('days')).toBe('7')
    // Read-only and named in words: not draggable, not a button, and a screen reader hears "Prayer time: …".
    await expect(bands.first()).toHaveAttribute('role', 'note')
    await expect(bands.first()).toHaveAttribute('aria-label', /^Prayer time: .+, \d\d:\d\d – \d\d:\d\d$/)
    await expect(bands.first()).not.toHaveAttribute('draggable', 'true')
    expect(await bands.first().evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none')
    expect(await bands.first().innerText()).toMatch(/\S/)   // the name is written on the band, not only coloured
    await page.getByRole('radio', { name: 'Day' }).click()
    await expect(bands.first()).toBeVisible()
    await page.getByRole('radio', { name: 'Month' }).click()
    await expect(page.locator('.calendar-grid.month')).toBeVisible()
    await expect(bands).toHaveCount(0)

    // Off: no line on Today, no bands, and the calendar does not ask for prayer times at all.
    await setPrefs(page, { prayer_enabled: false })
    reads.length = 0
    await page.goto('/')
    await expect(page.locator('.today-head h1')).toBeVisible()
    await expect(page.getByTestId('next-prayer')).toHaveCount(0)
    await expect(page.getByTestId('ramadan-note')).toHaveCount(0)
    await page.goto('/calendar')
    await expect(page.locator('.time-grid')).toBeVisible()
    await expect(bands).toHaveCount(0)
    expect(reads).toEqual([])
  } finally { await restore(page, saved) }
})

test('Settings: a city fills the place and suggests a method, the current location button uses the device only when clicked, and a 422 shows on the field', async ({ page, context, setLanguage, guard }) => {
  guard.allowConsole(/status of 422/)   // the browser logs the refused save (the refusal is what this test looks at)
  await setLanguage('en')
  const saved = await keep(page)
  try {
    await setPrefs(page, { prayer_enabled: false, prayer_lat: null, prayer_lng: null, prayer_method: 'muslim_world_league', ramadan_mode: 'off' })
    await context.grantPermissions(['geolocation']); await context.setGeolocation({ latitude: 21.4225, longitude: 39.8262 })
    await page.addInitScript(() => { const get = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation); (window as unknown as { geoCalls: number }).geoCalls = 0; navigator.geolocation.getCurrentPosition = (...a) => { (window as unknown as { geoCalls: number }).geoCalls++; return get(...a) } })
    await page.goto('/settings')
    const lat = page.getByLabel(/^Latitude/), lng = page.getByLabel(/^Longitude/)
    expect(await page.evaluate(() => (window as unknown as { geoCalls: number }).geoCalls)).toBe(0)   // nothing asked for the location on load

    // 422 on the checkbox when there is no place yet; the message sits beside the field.
    await page.getByLabel(/Show prayer times/).check()
    await saveButton(page).click()
    await expect(page.getByLabel(/Show prayer times/)).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('alert').filter({ hasText: 'Set your coordinates' })).toBeVisible()

    // A city: coordinates and the usual method for its country.
    await page.getByLabel('City').selectOption({ label: 'Cairo' })
    await expect(lat).toHaveValue('30.0444'); await expect(lng).toHaveValue('31.2357')
    await expect(page.getByLabel('Calculation method')).toHaveValue('egyptian')
    await page.getByLabel('Calculation method').selectOption('karachi')   // changeable

    // The current location, only on the click.
    await page.getByRole('button', { name: 'Use my current location' }).click()
    await expect(lat).toHaveValue('21.4225'); await expect(lng).toHaveValue('39.8262')
    expect(await page.evaluate(() => (window as unknown as { geoCalls: number }).geoCalls)).toBe(1)
    await expect(page.getByLabel('City')).toHaveValue('makkah')   // the coordinates are Makkah's: the list shows it

    // Typed coordinates are checked on the field.
    await lat.fill('95'); await expect(page.getByText('Enter a number between −90 and 90.')).toBeVisible()
    await lat.fill('21.4225')
    await page.getByLabel('Ramadan mode').selectOption('auto')
    await expect(page.getByLabel(/for iftar/)).toBeVisible()
    await saveButton(page).click()
    await expect(page.getByRole('status').filter({ hasText: 'Changes saved.' })).toBeVisible()
    const after = (await call(page, 'GET', '/api/settings')).body
    expect(after).toMatchObject({ prayer_enabled: true, prayer_lat: 21.4225, prayer_lng: 39.8262, prayer_method: 'karachi', ramadan_mode: 'auto' })
  } finally { await restore(page, saved) }
})

test('Settings: a denied location says so in plain words and changes nothing', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.addInitScript(() => { navigator.geolocation.getCurrentPosition = (_ok, fail) => fail?.({ code: 1, message: 'denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }) })
  await page.goto('/settings')
  const lat = page.getByLabel(/^Latitude/), before = await lat.inputValue()
  await page.getByRole('button', { name: 'Use my current location' }).click()
  await expect(page.getByText(/Location access was denied/)).toBeVisible()
  await expect(lat).toHaveValue(before)
})

test('the event form notes an overlap with a prayer, never blocks saving, and sends exactly what was typed', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const saved = await keep(page)
  let created: number | null = null
  try {
    await setPrefs(page, { ...MAKKAH, ramadan_mode: 'off' })
    // A Sunday far ahead (the demo account's routines never reach it), in the zone the server calculates in.
    const info = (await call(page, 'GET', '/api/prayer-times?from=2000-01-01')).body as { timezone: string }
    const day = await page.evaluate(zone => { const at = new Date(Date.now() + 400 * 86_400_000); while (at.toLocaleDateString('en-US', { timeZone: zone, weekday: 'short' }) !== 'Sun') at.setTime(at.getTime() + 86_400_000); return at.toLocaleDateString('en-CA', { timeZone: zone }) }, info.timezone)
    const data = (await call(page, 'GET', `/api/prayer-times?from=${day}&days=1`)).body as { timezone: string; days: { windows: { prayer: string; starts_at: string; ends_at: string }[] }[] }
    const win = data.days[0].windows.find(w => w.prayer === 'asr') ?? data.days[0].windows[0]
    expect(win, 'a prayer window on that day').toBeTruthy()
    const start = new Date(Date.parse(win.starts_at) + 5 * 60_000), end = new Date(start.getTime() + 20 * 60_000)
    const wall = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: data.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d).replace(', ', 'T')

    await page.goto('/calendar')
    await page.getByRole('button', { name: 'New event' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Title').fill(`E2E prayer overlap ${Date.now()}`)
    await dialog.locator('select', { has: page.locator('option[value="flexible"]') }).selectOption('flexible')
    await pick(page, field(dialog, 'Start'), wall(start)); await pick(page, field(dialog, 'End'), wall(end))
    const note = dialog.locator('.prayer-note')
    await expect(note).toBeVisible()
    await expect(note).toHaveText(/^This overlaps (Fajr|Dhuhr|Asr|Maghrib|Isha)( \+ \w+)* \(\d\d:\d\d\)\. You can still save\.$/)
    const save = dialog.getByRole('button', { name: /^(Save|Create)/ })
    await expect(save).toBeEnabled()

    // A time just after the window has no note (touching is not overlapping).
    await pick(page, field(dialog, 'Start'), wall(new Date(Date.parse(win.ends_at) + 60 * 60_000))); await pick(page, field(dialog, 'End'), wall(new Date(Date.parse(win.ends_at) + 90 * 60_000)))
    await expect(note).toHaveCount(0)
    await pick(page, field(dialog, 'Start'), wall(start)); await pick(page, field(dialog, 'End'), wall(end))
    await expect(note).toBeVisible()

    const posted = page.waitForResponse(r => /\/api\/events$/.test(r.url()) && r.request().method() === 'POST')
    await save.click()
    const response = await posted
    expect(response.status(), await response.text()).toBe(201)
    const event = (await response.json()).data as { id: number; starts_at: string; ends_at: string }
    created = event.id
    expect(new Date(event.starts_at).getTime()).toBe(start.getTime()); expect(new Date(event.ends_at).getTime()).toBe(end.getTime())
  } finally {
    if (created) await call(page, 'DELETE', `/api/events/${created}`)
    await restore(page, saved)
  }
})

test('turned off, the event form shows no prayer note and nothing asks for prayer times', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const saved = await keep(page)
  try {
    await setPrefs(page, { prayer_enabled: false })
    const reads: string[] = []
    page.on('request', r => { if (r.url().includes('/api/prayer-times')) reads.push(r.url()) })
    await page.goto('/calendar')
    await page.getByRole('button', { name: 'New event' }).click()
    await expect(page.getByRole('dialog').getByLabel('Title')).toBeVisible()
    await expect(page.locator('.prayer-note')).toHaveCount(0)
    expect(reads).toEqual([])
  } finally { await restore(page, saved) }
})

test('Arabic at 320 px: prayer settings, Today and the calendar bands fit, read in Arabic and pass axe', async ({ page, setLanguage }) => {
  await setLanguage('ar')
  const saved = await keep(page)
  try {
    await setPrefs(page, { ...MAKKAH, language: 'ar' })
    await page.setViewportSize({ width: 320, height: 700 })
    await page.goto('/settings')
    await expect(page.getByRole('group', { name: 'أوقات الصلاة ورمضان' })).toBeVisible()
    await expect(page.getByLabel('المدينة')).toBeVisible()
    await expect(page.getByRole('button', { name: 'استخدم موقعي الحالي' })).toBeVisible()
    await expect(page.getByLabel('وضع رمضان')).toHaveValue('on')
    await expect(page.getByLabel('دقائق مخصصة للإفطار')).toBeVisible()
    await expect(page.getByText('الأوقات محسوبة وقد تختلف بدقيقة أو دقيقتين')).toBeVisible()
    await noHorizontalOverflow(page)
    expect(await a11yViolations(page, '.settings-grid')).toEqual([])

    await page.goto('/')
    await expect(page.getByTestId('next-prayer')).toContainText('الصلاة التالية:')
    await expect(page.getByTestId('ramadan-note')).toContainText('وضع رمضان')
    await noHorizontalOverflow(page)
    expect(await a11yViolations(page, '.prayer-today')).toEqual([])

    await page.goto('/calendar')
    for (const view of ['يوم', 'أسبوع']) {
      await page.getByRole('radio', { name: view }).click()
      await expect(page.locator('.prayer-band').first()).toBeVisible()
      await expect(page.locator('.prayer-band').first()).toHaveAttribute('aria-label', /^وقت الصلاة: /)
      await noHorizontalOverflow(page)
      expect(await a11yViolations(page, '.calendar-page')).toEqual([])
    }
  } finally { await restore(page, saved) }
})
