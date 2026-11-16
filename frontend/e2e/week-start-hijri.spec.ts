import { test, expect, noHorizontalOverflow } from './fixtures'
import { a11yViolations } from './axe'
import type { Page } from '@playwright/test'

/**
 * The first day of the week and the optional Hijri date are account settings. These tests change them through the Settings page
 * (the real feature), look at the calendar, Timeline and Today, and put the account's own values back afterwards.
 * Nothing here depends on today's date: they check the ORDER of the weekdays and the SHAPE of a Hijri date, never a particular day.
 */
type Calendar = { week_start: number; calendar_system: string; hijri_offset: number }

async function api(page: Page, method: 'GET' | 'PUT', body?: unknown) {
  return page.evaluate(async ([m, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch('/api/settings', { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: await r.json() as Calendar }
  }, [method, body] as const)
}
const keep = async (page: Page): Promise<Calendar> => { await page.goto('/settings'); const { body } = await api(page, 'GET'); return { week_start: body.week_start, calendar_system: body.calendar_system, hijri_offset: body.hijri_offset } }
const restore = async (page: Page, saved: Calendar) => { await page.goto('/settings'); expect((await api(page, 'PUT', saved)).status).toBe(200) }

/** The system select: its label text also contains the option names, so it is found by where the label starts. */
const calendarSelect = (page: Page, label: string) => page.locator('label', { hasText: new RegExp(`^${label}`) }).locator('select')

/** Weekday numbers (0 = Sunday) of the dates read from the headers, in the order shown. */
const weekdaysOf = (days: string[]) => days.map(d => new Date(`${d}T12:00:00`).getDay())

test('Week starts on: Saturday reorders the calendar week and the Timeline and Today week boundaries', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const saved = await keep(page)
  try {
    await page.goto('/settings')
    const select = page.getByLabel('Week starts on')
    await expect(select).toBeVisible()
    expect(await select.locator('option').allTextContents()).toEqual(['Saturday', 'Sunday', 'Monday'])
    await select.selectOption('6')
    await page.getByRole('button', { name: 'Save preferences' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Changes saved.' })).toBeVisible()
    expect((await api(page, 'GET')).body.week_start).toBe(6)

    // The working-days checkboxes follow the same order.
    await expect(page.locator('.weekday-picker label').first()).toContainText('Sat')
    await expect(page.locator('.weekday-picker label').last()).toContainText('Fri')

    // Calendar, week view: Saturday first, Friday last, and the seven columns are consecutive days.
    await page.goto('/calendar')
    await page.getByRole('radio', { name: 'Week' }).click()
    const heads = page.locator('.time-grid-head > div')
    await expect(heads).toHaveCount(7)
    await expect(heads.first().locator('span').first()).toHaveText('Sat')
    await expect(heads.last().locator('span').first()).toHaveText('Fri')
    expect(await heads.locator('span:first-child').allTextContents()).toEqual(['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'])

    // Timeline, week view: the seven days run Saturday to Friday.
    await page.goto('/timeline')
    await page.getByRole('radio', { name: 'Week' }).click()
    const titles = page.locator('.tl-day header h2')
    await expect(titles).toHaveCount(7)
    const names = await titles.allTextContents()
    expect(names[0]).toMatch(/^Saturday/)
    expect(names[6]).toMatch(/^Friday/)

    // Today's planned-versus-actual card and the Planning page ask for the current week: it starts on a Saturday that is at most six days back.
    const insights = page.waitForRequest(r => /\/api\/plans\/insights\?from=/.test(r.url()) && weekdaysOf([new URL(r.url()).searchParams.get('from')!])[0] === 6, { timeout: 15_000 })   // the first request may go out before the settings have arrived
    await page.goto('/planning')
    const from = new URL((await insights).url()).searchParams.get('from')!
    expect(weekdaysOf([from])).toEqual([6])
    const ago = (Date.now() - new Date(`${from}T12:00:00`).getTime()) / 86400000
    expect(ago).toBeGreaterThan(-0.6); expect(ago).toBeLessThan(6.6)

    // Switching to Sunday moves all of them.
    await page.goto('/settings')
    await page.getByLabel('Week starts on').selectOption('0')
    await page.getByRole('button', { name: 'Save preferences' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Changes saved.' })).toBeVisible()
    await page.goto('/calendar')
    await page.getByRole('radio', { name: 'Week' }).click()
    expect(await page.locator('.time-grid-head > div span:first-child').allTextContents()).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
  } finally { await restore(page, saved) }
})

test('Hijri dates appear in Today and the calendar only when turned on', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const saved = await keep(page)
  try {
    await restore(page, { ...saved, calendar_system: 'gregorian', hijri_offset: 0 })
    await page.goto('/settings')
    await expect(page.getByLabel('Adjust Hijri date')).toHaveCount(0)
    await calendarSelect(page, 'Calendar').selectOption('hijri')
    const adjust = page.getByLabel('Adjust Hijri date')
    await expect(adjust).toBeVisible()
    expect(await adjust.locator('option').count()).toBe(3)
    await expect(page.getByText('may differ by a day from your local moon sighting')).toBeVisible()
    await page.getByRole('button', { name: 'Save preferences' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Changes saved.' })).toBeVisible()
    expect((await api(page, 'GET')).body.calendar_system).toBe('hijri')

    await page.goto('/')
    const hijri = page.locator('.today-head h1 .hijri')
    await expect(hijri).toBeVisible()
    await expect(hijri).toHaveText(/1[34]\d\d/)   // a Hijri year such as 1448

    await page.goto('/calendar')
    await expect(page.locator('.cal-bar h1 .hijri')).toHaveText(/1[34]\d\d/)
    await page.getByRole('radio', { name: 'Week' }).click()
    await expect(page.locator('.time-grid-head .hijri')).toHaveCount(7)
    await page.getByRole('radio', { name: 'Month' }).click()
    await expect(page.locator('.calendar-day .hijri').nth(27)).toBeVisible()   // every cell of the month has one
    await page.getByRole('radio', { name: 'Agenda' }).click()
    await expect(page.locator('.agenda-day .hijri').first()).toBeVisible()

    await page.goto('/timeline')
    await expect(page.locator('.tl-day header h2 .hijri').first()).toBeVisible()

    // Off again: no Hijri date anywhere.
    await page.goto('/settings')
    await calendarSelect(page, 'Calendar').selectOption('gregorian')
    await expect(page.getByLabel('Adjust Hijri date')).toHaveCount(0)
    await page.getByRole('button', { name: 'Save preferences' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Changes saved.' })).toBeVisible()
    await page.goto('/')
    await expect(page.locator('.today-head h1')).toBeVisible()
    await expect(page.locator('.hijri')).toHaveCount(0)
    await page.goto('/calendar')
    await expect(page.locator('.cal-bar h1')).toBeVisible()
    await expect(page.locator('.hijri')).toHaveCount(0)
  } finally { await restore(page, saved) }
})

test('Arabic at 320 px: week start, Hijri dates and their settings fit and pass axe', async ({ page, setLanguage }) => {
  await setLanguage('ar')
  const saved = await keep(page)
  try {
    await restore(page, { week_start: 6, calendar_system: 'hijri', hijri_offset: 1 })
    await page.setViewportSize({ width: 320, height: 700 })

    await page.goto('/settings')
    await expect(page.getByLabel('يبدأ الأسبوع يوم')).toBeVisible()
    await expect(calendarSelect(page, 'التقويم')).toHaveValue('hijri')
    await expect(page.getByLabel('تعديل التاريخ الهجري')).toBeVisible()
    await expect(page.getByText('تقويم أم القرى')).toBeVisible()
    await noHorizontalOverflow(page)
    expect(await a11yViolations(page, '.settings-grid')).toEqual([])

    await page.goto('/')
    await expect(page.locator('.today-head h1 .hijri')).toBeVisible()
    await noHorizontalOverflow(page)
    expect(await a11yViolations(page, '.today-head')).toEqual([])

    await page.goto('/calendar')
    for (const view of ['أسبوع', 'شهر', 'جدول']) {
      await page.getByRole('radio', { name: view }).click()
      await expect(page.locator('.cal-bar h1 .hijri')).toBeVisible()
      await noHorizontalOverflow(page)
      expect(await a11yViolations(page, '.calendar-page')).toEqual([])
    }

    await page.goto('/timeline')
    await expect(page.locator('.tl-day header h2 .hijri').first()).toBeVisible()
    await noHorizontalOverflow(page)
  } finally { await restore(page, saved) }
})
