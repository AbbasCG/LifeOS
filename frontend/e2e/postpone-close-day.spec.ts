import { test, expect, zonedInstant } from './fixtures'
import { a11yViolations } from './axe'
import type { Page, TestInfo } from '@playwright/test'

/**
 * Smart postpone and "Close the day" on a brand-new account (registered through the API), so nothing depends on the demo data or on the time
 * of day: the account's zone is picked so that its local clock reads between 11:00 and 15:00 now, every day is a work day and the work hours are
 * 08:00–10:00 (already over today, so the evening suggestion applies; still to come tomorrow and next week, so a session has room there).
 * Every task and session made here is removed in a `finally`, and the account is signed out.
 */
const ZONES = ['Pacific/Pago_Pago', 'Pacific/Honolulu', 'America/Phoenix', 'America/Guatemala', 'America/Bogota', 'America/Puerto_Rico', 'America/Sao_Paulo', 'America/Noronha',
  'Atlantic/Cape_Verde', 'UTC', 'Africa/Lagos', 'Africa/Johannesburg', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Shanghai', 'Asia/Tokyo',
  'Australia/Brisbane', 'Pacific/Noumea', 'Pacific/Tarawa', 'Pacific/Tongatapu', 'Pacific/Kiritimati']
const hourIn = (zone: string, at = Date.now()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(at))
const ZONE = ZONES.find(z => hourIn(z) >= 11 && hourIn(z) < 15) ?? 'UTC'
test.use({ storageState: { cookies: [], origins: [] }, timezoneId: ZONE })

const PASSWORD = 'a-long-e2e-password'
type Reply = { status: number; body: Record<string, unknown> & { data?: unknown } }
async function call(page: Page, method: string, path: string, body?: unknown): Promise<Reply> {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? {} : await r.json().catch(() => ({})) }
  }, [method, path, body] as const)
}
type Task = { id: number; title: string; status: string; due_at: string | null; due_date: string | null; due_all_day: boolean; schedule: { session_id: number; starts_at: string; ends_at: string } | null }
const localDay = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(Date.now() + offset * 86_400_000)
const clock = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
const iso = (at: string) => new Date(at).toISOString().replace('.000Z', 'Z')

/** A new account in ZONE, signed in on this page, with the work hours described above. */
async function freshAccount(page: Page, testInfo: TestInfo, language: 'en' | 'ar' = 'en') {
  await page.addInitScript(l => { if (!localStorage.getItem('lifeos-language')) localStorage.setItem('lifeos-language', l) }, language)
  await page.goto('/login')
  await page.evaluate(() => fetch('/sanctum/csrf-cookie', { credentials: 'include' }))
  const email = `e2e-postpone-${testInfo.project.name}-${Date.now()}@lifeos.local`
  const made = await call(page, 'POST', '/api/register', { name: 'E2E Postpone', email, password: PASSWORD, password_confirmation: PASSWORD, timezone: ZONE, language })
  expect(made.status).toBe(201)
  const settings = await call(page, 'PUT', '/api/settings', { timezone: ZONE, language, work_start: '08:00', work_end: '10:00', work_days: [0, 1, 2, 3, 4, 5, 6] })
  expect(settings.status).toBe(200)
}
async function cleanup(page: Page, taskIds: number[]) {
  for (const id of taskIds) {
    const task = await getTask(page, id).catch(() => null)
    if (task?.schedule) await call(page, 'DELETE', `/api/events/${task.schedule.session_id}`)
    await call(page, 'DELETE', `/api/tasks/${id}`)
  }
  // The e2e database is thrown away after the run; DELETE /api/account currently fails on the server (see the report), so the account is signed out.
  expect((await call(page, 'POST', '/api/logout')).status).toBeLessThan(300)
}
async function makeTask(page: Page, body: Record<string, unknown>): Promise<Task> {
  const r = await call(page, 'POST', '/api/tasks', { status: 'todo', priority: 'urgent', estimated_minutes: 60, ...body })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.data as Task
}
async function getTask(page: Page, id: number): Promise<Task> {
  const r = await call(page, 'GET', `/api/tasks/${id}`)
  expect(r.status).toBe(200)
  return (r.body.data ?? r.body) as Task
}
async function openRow(page: Page, title: string) {
  await page.goto('/tasks')
  const row = page.locator('li.task-item', { hasText: title })
  await row.locator('.task-body').click()
  return row
}

test('Postpone "Next week" moves the same session row, and the toast’s Undo puts it back exactly; a deadline-only task moves its date', async ({ page, guard }, testInfo) => {
  test.slow()
  guard.allowConsole(/status of 401/)   // the app asks who is signed in before there is anyone, and again after the account is removed
  await freshAccount(page, testInfo)
  const ids: number[] = []
  try {
    const booked = await makeTask(page, { title: `E2E booked ${Date.now()}`, schedule: { starts_at: zonedInstant(`${localDay(1)}T09:00`, ZONE) } })
    ids.push(booked.id)
    const before = (await getTask(page, booked.id)).schedule!
    expect(before.starts_at).toBe(iso(zonedInstant(`${localDay(1)}T09:00`, ZONE)))

    const row = await openRow(page, booked.title)
    const trigger = row.getByRole('button', { name: `Postpone “${booked.title}”` })
    await trigger.click()
    const menu = row.getByRole('menu', { name: 'Postpone' })
    await expect(menu.getByRole('menuitem')).toHaveText(['Tomorrow', 'Next week', 'Suggest a time…', 'Pick a date…'])
    const reply = page.waitForResponse(r => r.url().endsWith(`/api/tasks/${booked.id}/postpone`) && r.request().method() === 'POST')
    await menu.getByRole('menuitem', { name: 'Next week' }).click()
    const answer = await reply
    expect(answer.status()).toBe(200)
    expect(answer.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/)
    expect(answer.request().postDataJSON()).toMatchObject({ to: 'next_week' })
    const moved = (await answer.json()).moved.session as { session_id: number; starts_at: string; ends_at: string }
    const toast = page.locator('.toast', { hasText: 'Moved to' })
    await expect(toast.locator('p')).toHaveText(new RegExp(`^Moved to .+ ${clock(moved.starts_at)}–${clock(moved.ends_at)}$`))

    // The same session row moved, later than it was, with the same length.
    const after = (await getTask(page, booked.id)).schedule!
    expect(after.session_id).toBe(before.session_id)
    expect(after.session_id).toBe(moved.session_id)
    expect(after.starts_at).toBe(moved.starts_at)
    expect(Date.parse(after.starts_at)).toBeGreaterThanOrEqual(Date.parse(before.ends_at))
    expect(Date.parse(after.ends_at) - Date.parse(after.starts_at)).toBe(Date.parse(before.ends_at) - Date.parse(before.starts_at))

    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByText('Put back where it was.')).toBeVisible()
    await expect.poll(async () => (await getTask(page, booked.id)).schedule).toEqual(expect.objectContaining({ session_id: before.session_id, starts_at: before.starts_at, ends_at: before.ends_at }))

    // A task with only a date-only deadline today: "Tomorrow" moves the date and keeps it date-only.
    const dated = await makeTask(page, { title: `E2E dated ${Date.now()}`, due_date: localDay(0), priority: 'medium' })
    ids.push(dated.id)
    const row2 = await openRow(page, dated.title)
    await row2.getByRole('button', { name: `Postpone “${dated.title}”` }).click()
    await row2.getByRole('menuitem', { name: 'Tomorrow' }).click()
    await expect(page.locator('.toast', { hasText: 'Deadline moved to' })).toBeVisible()
    await expect.poll(async () => (await getTask(page, dated.id)).due_date).toBe(localDay(1))
    expect((await getTask(page, dated.id)).due_all_day).toBe(true)
    expect((await getTask(page, dated.id)).schedule).toBeNull()
  } finally { await cleanup(page, ids) }
})

test('Close the day: the evening card, the recap, Apply rolls today’s deadline to tomorrow and Undo puts it back', async ({ page, guard }, testInfo) => {
  test.slow()
  guard.allowConsole(/status of 401/)   // the app asks who is signed in before there is anyone, and again after the account is removed
  await freshAccount(page, testInfo)
  const ids: number[] = []
  try {
    const open = await makeTask(page, { title: `E2E still open ${Date.now()}`, due_date: localDay(0) })
    ids.push(open.id)
    const done = await makeTask(page, { title: `E2E finished ${Date.now()}`, priority: 'low' })
    ids.push(done.id)
    expect((await call(page, 'PATCH', `/api/tasks/${done.id}`, { status: 'completed' })).status).toBe(200)

    await page.goto('/')
    const card = page.getByRole('region', { name: 'Close the day' })
    await expect(card).toHaveText('Your work day is over: 1 thing is still open. Close the day?Close the day')
    await card.getByRole('button', { name: 'Close the day' }).click()
    const dialog = page.getByRole('dialog', { name: 'Close the day' })
    const recap = dialog.getByRole('region', { name: 'Today so far' })
    await expect(recap.locator('[data-recap]')).toHaveText('Done today: 1 task · 0 min focus · planned 0 min')
    await expect(recap.getByRole('listitem')).toHaveText([done.title])
    const item = dialog.locator('li', { hasText: open.title })
    await expect(item).toContainText('Deadline today')
    // Previewing changed nothing.
    expect((await getTask(page, open.id)).due_date).toBe(localDay(0))

    await dialog.getByRole('button', { name: 'Apply 1 change(s)' }).click()
    await expect(dialog.getByText('Applied', { exact: true })).toBeVisible()
    await expect.poll(async () => (await getTask(page, open.id)).due_date).toBe(localDay(1))
    expect((await getTask(page, open.id)).due_all_day).toBe(true)

    await dialog.getByRole('button', { name: /Undo these changes/ }).click()
    await expect(page.getByText('All changes undone.')).toBeVisible()
    await expect.poll(async () => (await getTask(page, open.id)).due_date).toBe(localDay(0))

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    // The permanent action is always there, next to "Reorganize my day".
    await expect(page.locator('.now-actions [data-close-day-open]')).toHaveText('Close the day')
  } finally { await cleanup(page, ids) }
})

test('Arabic at 320 px: the postpone menu and the close-the-day sheet do not overflow and have no accessibility violations', async ({ page, guard }, testInfo) => {
  test.slow()
  guard.allowConsole(/status of 401/)   // the app asks who is signed in before there is anyone, and again after the account is removed
  await page.setViewportSize({ width: 320, height: 800 })
  await freshAccount(page, testInfo, 'ar')
  const ids: number[] = []
  const overflow = (selector: string) => page.evaluate(s => {
    const el = document.querySelector(s)!, r = el.getBoundingClientRect()
    return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, left: r.left < 0, right: r.right > document.documentElement.clientWidth }
  }, selector)
  try {
    const task = await makeTask(page, { title: `مهمة تجريبية طويلة الاسم ${Date.now()}`, due_date: localDay(0) })
    ids.push(task.id)
    const row = await openRow(page, task.title)
    await row.getByRole('button', { name: `تأجيل «${task.title}»` }).click()
    const menu = row.getByRole('menu', { name: 'تأجيل' })
    await expect(menu.getByRole('menuitem')).toHaveText(['غدًا', 'الأسبوع القادم', 'اقترح وقتًا…', 'اختر تاريخًا…'])
    await expect(menu.getByRole('menuitem').first()).toBeFocused()
    await expect.poll(() => overflow('.rec-popover')).toEqual({ page: 0, left: false, right: false })
    expect(await a11yViolations(page, '.task-item.expanded')).toEqual([])
    // "Suggest a time…" shows the day it would use, still on screen.
    await menu.getByRole('menuitem', { name: 'اقترح وقتًا…' }).click()
    const panel = row.getByRole('group', { name: 'اقترح وقتًا' })
    await expect(panel).toContainText('المقترح:')
    await expect.poll(() => overflow('.rec-popover')).toEqual({ page: 0, left: false, right: false })
    expect(await a11yViolations(page, '.task-item.expanded')).toEqual([])
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)

    await page.goto('/')
    await page.locator('.now-actions [data-close-day-open]').click()
    const dialog = page.getByRole('dialog', { name: 'أغلق اليوم' })
    await expect(dialog.getByRole('region', { name: 'اليوم حتى الآن' })).toContainText('أُنجز اليوم:')
    await expect(dialog.getByText('موعدها النهائي اليوم').first()).toBeVisible()
    expect(await page.evaluate(() => {
      const d = document.querySelector('dialog[open]')!, inner = d.querySelector('.sheet-inner')!
      return [document.documentElement.scrollWidth - document.documentElement.clientWidth, d.scrollWidth - d.clientWidth, inner.scrollWidth - inner.clientWidth]
    })).toEqual([0, 0, 0])
    expect(await a11yViolations(page, 'dialog[open]')).toEqual([])
    await dialog.getByRole('button', { name: 'ليس الآن' }).click()
    await expect(dialog).toHaveCount(0)
  } finally { await cleanup(page, ids) }
})
