import { test, expect, field, pick, noHorizontalOverflow } from './fixtures'
import { a11yViolations } from './axe'
import type { Page } from '@playwright/test'

/**
 * A deadline with a date and no time. The browser here is in Auckland while the demo account is in Amsterdam, so a client that read
 * the browser's calendar would file the day under the wrong date. Real Laravel server, throwaway database.
 */
test.use({ timezoneId: 'Pacific/Auckland' })

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b === undefined ? undefined : JSON.stringify(b) })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body] as const)
}
type Row = { due_at: string | null; due_all_day: boolean; due_date: string | null }
const read = async (page: Page, id: number) => ((await call(page, 'GET', `/api/tasks/${id}`)).body as { data: Row }).data
const dayText = (day: string, language = 'en') => new Intl.DateTimeFormat(language, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`))

async function makeTask(page: Page, label: string) {
  await page.goto('/')
  const zone = (await call(page, 'GET', '/api/settings')).body.timezone as string
  const title = `E2E date-only ${label} ${Date.now()}`
  const made = await call(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'medium', estimated_minutes: 30 })
  expect(made.status).toBe(201)
  return { id: (made.body.data as { id: number }).id, title, zone }
}
const accountDay = (zone: string, plus = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(Date.now() + plus * 86_400_000))
/** Open «خيارات متقدمة» / More options and switch the deadline on, so its fields can be used. */
async function showDeadline(dialog: import('@playwright/test').Locator) {
  const sw = dialog.getByRole('checkbox', { name: /Do you have a deadline|هل لديك موعد نهائي/ })
  if (!(await sw.isVisible())) await dialog.locator('summary').click()
  if (!(await sw.isChecked())) await sw.check()
}
async function openDialog(page: Page, title: string) {
  await page.goto('/tasks')
  const row = page.locator('.task-item', { hasText: title })
  if ((await row.locator('.task-body').getAttribute('aria-expanded')) !== 'true') await row.locator('.task-body').click()
  await row.getByRole('button', { name: /^Edit|^تعديل/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

test('a date-only deadline: set in the dialog, shown without a time, persists, moves as a date, and can become timed', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const { id, title, zone } = await makeTask(page, 'flow')
  const day = accountDay(zone, 9), tomorrow = accountDay(zone, 1)
  try {
    let dialog = await openDialog(page, title)
    await showDeadline(dialog)
    const toggle = dialog.getByRole('checkbox', { name: 'No specific time' })
    await expect(toggle).not.toBeChecked()
    await toggle.check()
    await pick(page, field(dialog, 'Deadline'), day)
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()

    const saved = await read(page, id)
    expect(saved.due_all_day).toBe(true); expect(saved.due_date).toBe(day)

    // The list shows the day and no time; a reload does not change it.
    for (const reload of [false, true]) {
      if (reload) await page.reload()
      else await page.goto('/tasks')
      const due = page.locator('.task-item', { hasText: title }).locator('.due')
      await expect(due).toContainText(dayText(day))
      expect(await due.textContent()).not.toMatch(/\d{1,2}:\d{2}/)
    }

    // Opening it again: toggle ON, the date shown, no time.
    dialog = await openDialog(page, title)
    await expect(dialog.getByRole('checkbox', { name: 'No specific time' })).toBeChecked()
    await expect(dialog.locator('.rf-deadline .dtp-trigger')).toHaveAttribute('data-value', day)
    await dialog.getByRole('button', { name: 'Save' }).click()   // untouched: nothing about the deadline is sent
    await expect(dialog).toBeHidden()
    expect((await read(page, id)).due_date).toBe(day)

    // Move to Tomorrow keeps it date-only.
    await page.goto('/tasks')
    const row = page.locator('.task-item', { hasText: title })
    await row.locator('.task-body').click()
    await row.getByRole('group', { name: 'Move to' }).getByRole('button', { name: 'Tomorrow' }).click()
    await expect.poll(async () => (await read(page, id)).due_date).toBe(tomorrow)
    expect((await read(page, id)).due_all_day).toBe(true)
    await expect(row.locator('.due')).toHaveCount(1)   // the row is redrawn after the move
    await expect(row.locator('.due')).toContainText('Tomorrow')
    expect(await row.locator('.due').textContent()).not.toMatch(/\d{1,2}:\d{2}/)

    // Switch the toggle off: it becomes a timed deadline (17:00 account time) and the list shows the time.
    dialog = await openDialog(page, title)
    await dialog.getByRole('checkbox', { name: 'No specific time' }).uncheck()
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    const timed = await read(page, id)
    expect(timed.due_all_day).toBe(false); expect(timed.due_date).toBeNull()
    await page.goto('/tasks')
    await expect(page.locator('.task-item', { hasText: title }).locator('.due')).toContainText('17:00')
  } finally { await call(page, 'DELETE', `/api/tasks/${id}`) }
})

test('the toggle is accessible, reads right in Arabic, and the dialog fits 320px', async ({ page, setLanguage }) => {
  await setLanguage('ar')
  const { id, title } = await makeTask(page, 'a11y')
  try {
    await page.setViewportSize({ width: 320, height: 700 })
    const dialog = await openDialog(page, title)
    await showDeadline(dialog)
    const toggle = dialog.getByRole('checkbox', { name: 'بدون وقت محدد' })
    await toggle.focus(); await page.keyboard.press('Space')
    await expect(toggle).toBeChecked()
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe('rtl')
    await noHorizontalOverflow(page)
    expect(await page.evaluate(() => { const d = document.querySelector('dialog.sheet'); return d ? d.scrollWidth <= d.clientWidth : true })).toBe(true)
    expect(await a11yViolations(page, 'dialog.sheet')).toEqual([])
  } finally { await call(page, 'DELETE', `/api/tasks/${id}`) }
})
