import { test, expect } from './fixtures'
import type { Locator, Page } from '@playwright/test'

/**
 * Every session and event time in the calendar reads on a 24-hour clock (08:00, 17:45, 00:00), in English, Arabic and Dutch, in the
 * day, week, month and agenda views, in event details, tooltips and aria-labels — and AM/PM appears nowhere on the page.
 * Real Laravel server, throwaway database: everything created here is removed at the end, and the account's zone/language are restored.
 */
const ZONE = 'Europe/Amsterdam'
test.use({ timezoneId: ZONE })

async function call(page: Page, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return page.evaluate(async ([m, p, b, h]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token, ...(h as Record<string, string>) }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body, headers] as const)
}

/** The instant at which the wall clock in `ZONE` reads `day` `time` (two passes settle the offset, also on a clock-change day). */
function instantAt(day: string, time: string): string {
  const [y, m, d] = day.split('-').map(Number), [h, mi] = time.split(':').map(Number)
  const wanted = Date.UTC(y, m - 1, d, h, mi)
  let guess = wanted
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(guess)).map(x => [x.type, Number(x.value)]))
    guess += wanted - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  }
  return new Date(guess).toISOString()
}

/** 'AM'/'PM' as a word or after a number, in Latin or Arabic (ص / م). */
const MERIDIEM = /(^|[^A-Za-z])(AM|PM|am|pm|a\.m\.|p\.m\.)([^A-Za-z]|$)|\d\s*[صم](\s|$)/
async function expectNo12Hour(page: Page) {
  const text = await page.locator('body').innerText()
  expect(text.match(MERIDIEM), 'AM/PM in the visible text').toBeNull()
  expect(text).not.toMatch(/(^|\D)24:\d\d/)
  const attrs = await page.evaluate(() => [...document.querySelectorAll('[aria-label],[title]')].map(e => `${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('title') ?? ''}`).join('\n'))
  expect(attrs.match(MERIDIEM), 'AM/PM in an aria-label or tooltip').toBeNull()
}

const LANGS = [['en', 'Evening class', 'Midnight call'], ['ar', 'Evening class', 'Midnight call'], ['nl', 'Evening class', 'Midnight call']] as const

test('the calendar and the task session show a 24-hour clock in en, ar and nl, in every view', async ({ page }) => {
  test.setTimeout(150_000)
  await page.goto('/')
  const settings = (await call(page, 'GET', '/api/settings')).body as { timezone: string; language?: string }
  const stamp = Date.now()
  const day = await page.evaluate(([zone, days]) => {
    const t = new Date(Date.now() + (days as number) * 86_400_000)
    return t.toLocaleDateString('en-CA', { timeZone: zone as string })
  }, [ZONE, 3] as const)
  const created: number[] = []
  let taskId: number | null = null
  const evening = `Evening class ${stamp}`, midnight = `Midnight call ${stamp}`, task = `Write the report ${stamp}`
  try {
    expect((await call(page, 'PUT', '/api/settings', { timezone: ZONE })).status).toBe(200)
    for (const [title, from, to] of [[evening, '17:45', '18:30'], [midnight, '00:00', '00:30']] as const) {
      const made = await call(page, 'POST', '/api/events', { title, kind: 'flexible', starts_at: instantAt(day, from), ends_at: instantAt(day, to), timezone: ZONE })
      expect(made.status).toBe(201)
      created.push((made.body as { data: { id: number } }).data.id)
    }
    const madeTask = await call(page, 'POST', '/api/tasks', { title: task, status: 'todo', priority: 'medium', estimated_minutes: 30 })
    expect(madeTask.status).toBe(201)
    taskId = (madeTask.body as { data: { id: number } }).data.id
    const booked = await call(page, 'POST', `/api/tasks/${taskId}/schedule`, { starts_at: instantAt(day, '13:00'), ends_at: instantAt(day, '13:30') }, { 'Idempotency-Key': crypto.randomUUID() })
    expect(booked.status).toBe(201)
    created.push((booked.body as { data: { id: number } }).data.id)

    for (const [language] of LANGS) {
      expect((await call(page, 'PUT', '/api/settings', { language })).status).toBe(200)
      for (const view of ['day', 'week', 'month', 'agenda'] as const) {
        await page.goto('/')
        await page.evaluate(v => localStorage.setItem('lifeos-calendar-view', v), view)
        await page.goto(`/calendar?date=${day}`)
        await expect(page.locator('html')).toHaveAttribute('lang', language)
        const card = (title: string): Locator => view === 'agenda' ? page.locator('.agenda-item', { hasText: title }) : view === 'month' ? page.locator('.calendar-event', { hasText: title }) : page.locator('.grid-event', { hasText: title })
        await expect(card(evening).first(), `${language} ${view}`).toBeVisible()
        if (view === 'agenda') {
          await expect(card(evening).locator('time strong')).toHaveText('17:45')
          await expect(card(evening).locator('time small')).toHaveText('18:30')
          await expect(card(midnight).locator('time strong')).toHaveText('00:00')
        } else if (view === 'month') {
          await expect(card(evening)).toContainText('17:45')
          await expect(card(midnight)).toContainText('00:00')
        } else {
          await expect(card(evening)).toContainText('17:45 – 18:30')
          await expect(card(midnight)).toContainText('00:00 – 00:30')
          // The hour labels and slot tooltips count 00..23 with two digits.
          await expect(page.locator('.time-gutter')).toContainText('13:00')
          await expect(page.locator('.time-gutter')).toContainText('23:00')
          await expect(page.locator('button.slot').nth(8).first()).toHaveAttribute('aria-label', /08:00/)
        }
        // The task's own session is drawn at 13:00 wherever the view lists timed items.
        if (view !== 'month') await expect(page.locator('[data-task-id]', { hasText: task }).first()).toContainText('13:00')
        await expectNo12Hour(page)

        if (view === 'agenda' || view === 'week') {
          // Details of an event and of the task's session.
          await card(evening).first().click()
          const dialog = page.getByRole('dialog').last()
          await expect(dialog).toBeVisible()
          await expect(dialog.locator('.dtp-trigger').filter({ hasText: '17:45' }).first()).toBeVisible()
          await expectNo12Hour(page)
          await page.keyboard.press('Escape')
          await expect(dialog).toBeHidden()
          await page.locator('[data-task-id]', { hasText: task }).first().click()
          const session = page.getByRole('region', { name: /Task session|جلسة المهمة|Taaksessie/ })
          await expect(session).toContainText('13:00 – 13:30')
          await expectNo12Hour(page)
          await page.keyboard.press('Escape')
        }
      }
      // The Tasks list says the same on its session badge.
      await page.goto('/tasks')
      const row = page.locator('.task-item', { hasText: task })
      await expect(row.locator('.sched-badge time')).toContainText('13:00')
      await expect(row.locator('.sched-badge')).toHaveAttribute('title', /13:00 – 13:30/)
      await expectNo12Hour(page)
    }
  } finally {
    for (const id of created) await call(page, 'DELETE', `/api/events/${id}`)
    if (taskId) await call(page, 'DELETE', `/api/tasks/${taskId}`)
    await call(page, 'PUT', '/api/settings', { timezone: settings.timezone, ...(settings.language ? { language: settings.language } : {}) })
  }
})

test('typing 00:00 and 13:00 in the event form is saved as that exact local time', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/')
  const settings = (await call(page, 'GET', '/api/settings')).body as { timezone: string }
  const ids: number[] = []
  try {
    expect((await call(page, 'PUT', '/api/settings', { timezone: ZONE })).status).toBe(200)
    await page.addInitScript(() => localStorage.setItem('lifeos-calendar-view', 'agenda'))
    // A Sunday far ahead: the demo account's weekday routines (stand-ups, reviews) never reach it.
    const day = await page.evaluate(zone => {
      const at = new Date(Date.now() + 400 * 86_400_000)
      while (at.toLocaleDateString('en-US', { timeZone: zone, weekday: 'short' }) !== 'Sun') at.setTime(at.getTime() + 86_400_000)
      return at.toLocaleDateString('en-CA', { timeZone: zone })
    }, ZONE)
    for (const [from, to] of [['00:00', '00:30'], ['13:00', '13:30']] as const) {
      await page.goto('/calendar')
      await page.getByRole('button', { name: 'New event' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Title').fill(`E2E clock form ${from} ${Date.now()}`)
      await dialog.locator('select', { has: page.locator('option[value="flexible"]') }).selectOption('flexible')
      const triggers = dialog.locator('.dtp-trigger')
      for (const [index, time] of [[0, from], [1, to]] as const) {
        await triggers.nth(index).click()
        const sheet = page.locator('.dtp-dialog[open]')
        await sheet.getByRole('textbox', { name: 'Date' }).fill(day); await sheet.getByRole('textbox', { name: 'Date' }).press('Enter')
        await sheet.getByRole('textbox', { name: 'Time' }).fill(time); await sheet.getByRole('textbox', { name: 'Time' }).press('Enter')
        await expect(sheet.getByRole('group', { name: /AM or PM/ })).toHaveCount(0)
        await sheet.getByRole('button', { name: 'Done' }).click()
        await expect(triggers.nth(index)).toContainText(time)
      }
      const saved = page.waitForResponse(r => /\/api\/events$/.test(r.url()) && r.request().method() === 'POST')
      await dialog.getByRole('button', { name: /^(Save|Create)/ }).click()
      const response = await saved
      expect(response.status(), await response.text()).toBe(201)
      const event = (await response.json()).data as { id: number; starts_at: string; ends_at: string }
      ids.push(event.id)
      expect(Date.parse(event.starts_at)).toBe(Date.parse(instantAt(day, from)))
      expect(Date.parse(event.ends_at)).toBe(Date.parse(instantAt(day, to)))
    }
  } finally {
    for (const id of ids) await call(page, 'DELETE', `/api/events/${id}`)
    await call(page, 'PUT', '/api/settings', { timezone: settings.timezone })
  }
})
