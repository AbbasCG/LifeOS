import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * The calendar is drawn in the account's timezone, not the browser's. The browser is in UTC; the account is put in a
 * zone whose offset is far from it (UTC+14 or UTC-11), so a block's time on screen is only right if the shift works.
 */
test.use({ timezoneId: 'UTC' })

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body] as const)
}

const clock = (iso: string | Date, zone: string) => new Date(iso).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', timeZone: zone })
const dayIn = (at: Date, zone: string) => at.toLocaleDateString('en-CA', { timeZone: zone })

test('the calendar shows times in the account’s zone, can switch to the device’s, and saves what you type in that zone', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/')
  const original = (await call(page, 'GET', '/api/settings')).body.timezone as string
  const zone = new Date().getUTCHours() >= 10 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago'
  const title = `E2E zone ${Date.now()}`
  let id: number | null = null
  try {
    expect((await call(page, 'PUT', '/api/settings', { timezone: zone })).status).toBe(200)
    // A block tomorrow (in the account's day) at 10:00 account time.
    const tomorrow = dayIn(new Date(Date.now() + 86_400_000), zone)
    const [y, m, d] = tomorrow.split('-').map(Number)
    const wanted = Date.UTC(y, m - 1, d, 10, 0)
    const wallAtGuess = Date.parse(new Date(wanted).toLocaleString('sv-SE', { timeZone: zone }).replace(' ', 'T') + 'Z')
    const starts = new Date(wanted - (wallAtGuess - wanted)), ends = new Date(starts.getTime() + 3_600_000)
    expect(clock(starts, zone)).toBe('10:00 AM')
    const made = await call(page, 'POST', '/api/events', { title, kind: 'flexible', starts_at: starts.toISOString(), ends_at: ends.toISOString(), timezone: zone })
    expect(made.status).toBe(201)
    id = made.body.data.id

    await page.addInitScript(() => localStorage.setItem('lifeos-calendar-view', 'agenda'))
    await page.goto('/calendar')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    const zoneNote = page.locator('.cal-zone')
    await expect(zoneNote).toBeVisible()
    await expect(zoneNote.getByRole('radio', { name: 'My account' })).toHaveAttribute('aria-checked', 'true')

    // Account zone: the agenda (the next seven days) lists the block at 10:00 AM.
    const item = page.locator('.agenda-item', { hasText: title })
    await expect(item).toBeVisible()
    await expect(item.locator('time strong')).toHaveText('10:00 AM')

    // Device zone (UTC): the same block reads the browser's time (and the free-time note appears).
    await zoneNote.getByRole('radio', { name: 'This device' }).click()
    await expect(zoneNote.getByText(/Free time is hidden/)).toBeVisible()
    await expect(page.locator('.agenda-item', { hasText: title }).locator('time strong')).toHaveText(clock(starts, 'UTC'))

    // Back to the account's zone, then make a new event by typing a time: it must be stored in that zone.
    await zoneNote.getByRole('radio', { name: 'My account' }).click()
    await page.getByRole('button', { name: 'New event' }).click()
    const dialog = page.getByRole('dialog')
    const typed = `${tomorrow}T15:30`
    const newTitle = `${title} typed`
    await dialog.getByLabel('Title', { exact: true }).fill(newTitle)
    await dialog.getByLabel('Start', { exact: true }).fill(typed)
    await dialog.getByLabel('End', { exact: true }).fill(`${tomorrow}T16:30`)
    await dialog.getByRole('button', { name: /^Save|Create/ }).click()
    await expect(dialog).toBeHidden()
    const list = await call(page, 'GET', `/api/calendar?from=${encodeURIComponent(new Date(wanted - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(wanted + 2 * 86_400_000).toISOString())}`)
    const typedEvent = (list.body.data as { id: string; title: string; starts_at: string; event_id: number }[]).find(e => e.title === newTitle)
    expect(typedEvent, 'the typed event is stored').toBeTruthy()
    expect(clock(typedEvent!.starts_at, zone)).toBe('03:30 PM')
    await call(page, 'DELETE', `/api/events/${typedEvent!.event_id}`)
  } finally {
    if (id !== null) await call(page, 'DELETE', `/api/events/${id}`)
    await call(page, 'PUT', '/api/settings', { timezone: original })
    await page.evaluate(() => { try { localStorage.removeItem('lifeos-calendar-zone'); localStorage.removeItem('lifeos-calendar-view') } catch { /* ignore */ } })
  }
})
