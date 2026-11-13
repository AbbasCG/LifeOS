import { test, expect, field, pick } from './fixtures'
import { a11yViolations } from './axe'
import type { Page } from '@playwright/test'

/**
 * The task edit dialog: the execution time («متى تريد تنفيذ المهمة؟») and the optional deadline are two different things. A deadline never
 * becomes an execution time, the old deadline is kept when only the execution time changes, and a task's calendar session is shown and moved from the dialog. Real Laravel server, throwaway database;
 * every task and session made here is removed at the end. Desktop runs light, the mobile project runs dark.
 */
test.use({ timezoneId: 'UTC' })

type Reply = { status: number; body: { code?: string; timezone?: string; data?: unknown } }
async function call(page: Page, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return page.evaluate(async ([m, p, b, h]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token, ...(h as Record<string, string>) }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body, headers] as const)
}
type Occurrence = { event_id: number | null; task_id: number | null; starts_at: string; ends_at: string }
async function sessionsOf(page: Page, taskId: number) {
  const from = new Date(Date.now() - 86_400_000).toISOString(), to = new Date(Date.now() + 40 * 86_400_000).toISOString()
  const r = await call(page, 'GET', `/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
  expect(r.status).toBe(200)
  return (r.body.data as unknown as Occurrence[]).filter(o => o.task_id === taskId)
}
/** Day ('YYYY-MM-DD') and wall time ('HH:mm') of an instant in a timezone. The deadline and session fields are on this same account clock; the browser here is in UTC, to prove it. */
const wall = (at: Date | string, zone: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(at)).map(x => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
}
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/**
 * A 30-minute slot at 10:00 UTC on the first day, from about three days ahead, with nothing in the calendar between 06:00 and 14:00 UTC. The demo data
 * has events and weekly series, so a fixed "in three days at 10:00" collides with one of them on some weekdays and the booking is (rightly) refused.
 */
async function freeSlot(page: Page) {
  for (let i = 3; i < 43; i++) {
    const day = new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10)
    const r = await call(page, 'GET', `/api/calendar?from=${encodeURIComponent(`${day}T06:00:00Z`)}&to=${encodeURIComponent(`${day}T14:00:00Z`)}`)
    if (r.status === 200 && (r.body.data as unknown[]).length === 0) return { starts_at: `${day}T10:00:00.000Z`, ends_at: `${day}T10:30:00.000Z` }
  }
  throw new Error('no free day found')
}

async function makeTask(page: Page, label: string, due: (zone: string, today: string) => string | null) {
  await page.goto('/')
  const zone = (await call(page, 'GET', '/api/settings')).body.timezone as string
  const title = `E2E when ${label} ${Date.now()}`
  const made = await call(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'medium', estimated_minutes: 30, due_at: due(zone, wall(new Date(), zone).day) })
  expect(made.status).toBe(201)
  return { id: (made.body.data as { id: number }).id, title, zone }
}
async function cleanup(page: Page, taskId: number) {
  for (const s of await sessionsOf(page, taskId)) if (s.event_id) await call(page, 'DELETE', `/api/events/${s.event_id}`)
  await call(page, 'DELETE', `/api/tasks/${taskId}`)
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
const deadlineValue = (dialog: ReturnType<Page['locator']>) => dialog.locator('.rf-deadline .dtp-trigger').getAttribute('data-value')
const startField = (dialog: ReturnType<Page['locator']>) => field(dialog, 'Start time')

test('an existing deadline is shown, kept when nothing about it changes, and removed only when the switch is turned off', async ({ page, setLanguage }) => {
  await setLanguage('en')
  // Due in 5 days at a time that is neither 17:00 nor 23:00, so a replaced time would show.
  const { id, title, zone } = await makeTask(page, 'time', (_z, today) => `${shift(today, 5)}T12:00:00.000Z`)
  try {
    let dialog = await openDialog(page, title)
    const dueWall = wall(`${shift(wall(new Date(), zone).day, 5)}T12:00:00.000Z`, zone)
    const sw = dialog.getByRole('checkbox', { name: /Do you have a deadline/ })
    await expect(sw).toBeChecked()                                                // «has a deadline»: on, with its value, no click needed
    expect(await deadlineValue(dialog)).toBe(`${dueWall.day}T${dueWall.time}`)    // the account's clock, not this UTC browser's
    // A deadline is NOT an execution time: the task is not scheduled, so "Not scheduled" is the chosen tile and there is no start field.
    await expect(dialog.getByRole('radio', { name: 'Not scheduled' })).toHaveAttribute('aria-checked', 'true')
    await expect(startField(dialog)).toHaveCount(0)

    const saved = page.waitForResponse(r => /\/api\/tasks\/\d+$/.test(r.url()) && r.request().method() === 'PATCH')
    await dialog.getByRole('button', { name: 'Save' }).click()
    expect((await saved).status()).toBe(200)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await sessionsOf(page, id)).toHaveLength(0)
    expect(Date.parse(((await call(page, 'GET', `/api/tasks/${id}`)).body.data as { due_at: string }).due_at)).toBe(Date.parse(`${shift(wall(new Date(), zone).day, 5)}T12:00:00.000Z`))

    dialog = await openDialog(page, title)
    await dialog.getByRole('checkbox', { name: /Do you have a deadline/ }).uncheck()
    await expect(dialog.getByText('Saving will remove the deadline.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(((await call(page, 'GET', `/api/tasks/${id}`)).body.data as { due_at: string | null }).due_at).toBeNull()
  } finally { await cleanup(page, id) }
})

test('a task due today is still not scheduled: the deadline never makes an execution time', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const { id, title } = await makeTask(page, 'custom', () => new Date(Date.now() + 3_600_000).toISOString())
  try {
    const dialog = await openDialog(page, title)
    await expect(dialog.getByRole('radio', { name: 'Not scheduled' })).toHaveAttribute('aria-checked', 'true')
    await expect(dialog.locator('.rf-when .sched-badge')).toHaveCount(0)
    await page.goto('/tasks')
    await expect(page.locator('.task-item', { hasText: title }).locator('.sched-badge')).toHaveCount(0)
  } finally { await cleanup(page, id) }
})

test('moving the session from the dialog changes the calendar once and keeps the number of events', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const { id, title, zone } = await makeTask(page, 'session', () => new Date(Date.now() + 12 * 86_400_000).toISOString())
  try {
    const slot = await freeSlot(page)
    const booked = await call(page, 'POST', `/api/tasks/${id}/schedule`, slot, { 'Idempotency-Key': crypto.randomUUID() })
    expect(booked.status).toBe(201)
    const eventId = (booked.body.data as { id: number }).id
    const dialog = await openDialog(page, title)
    const block = dialog.locator('.rf-when')
    await expect(block.locator('.sched-badge')).toBeVisible()
    await expect(startField(dialog)).toHaveAttribute('data-value', wall(slot.starts_at, zone).time)   // the session's own time, apart from the deadline
    await expect(dialog.locator('.rf-end')).toContainText(wall(slot.ends_at, zone).time)

    // The new start is saved by the dialog's own Save: ONE PATCH carrying the schedule, the same session moves.
    const patches: string[] = []
    page.on('request', r => { if (r.method() === 'PATCH' && /\/api\/tasks\/\d+$/.test(r.url())) patches.push(r.postData() ?? '') })
    await pick(page, startField(dialog), '11:30')
    await expect(dialog.locator('.rf-end')).toHaveText('Ends 12:00')
    await dialog.getByRole('button', { name: 'Save' }).dblclick()
    await expect(dialog).toBeHidden()
    expect(patches).toHaveLength(1); expect(JSON.parse(patches[0])).not.toHaveProperty('due_at')
    await openDialog(page, title)   // after a reload it still shows the new time

    const after = await sessionsOf(page, id)
    expect(after).toHaveLength(1)
    expect(after[0].event_id).toBe(eventId)
    expect(after[0].starts_at).not.toBe(slot.starts_at)
    await expect(startField(page.getByRole('dialog'))).toHaveAttribute('data-value', '11:30')

    // The session is drawn in the calendar once, at its new time.
    await page.goto(`/calendar?date=${wall(after[0].starts_at, zone).day}&session=${eventId}`)
    const drawn = page.locator(`[data-session="${eventId}"]`)
    await expect(drawn).toHaveCount(1)
    await expect(drawn).toContainText(/11:30/)
    await expect(page.locator('[data-session]', { hasText: title })).toHaveCount(1)
  } finally { await cleanup(page, id) }
})

test('the dialog reads right in Arabic (right to left) with the execution time and the deadline apart', async ({ page, setLanguage }) => {
  await setLanguage('ar')
  const { id, title } = await makeTask(page, 'rtl', () => new Date(Date.now() + 12 * 86_400_000).toISOString())
  try {
    const slot = await freeSlot(page)
    expect((await call(page, 'POST', `/api/tasks/${id}/schedule`, slot, { 'Idempotency-Key': crypto.randomUUID() })).status).toBe(201)
    await page.goto('/tasks')
    const row = page.locator('.task-item', { hasText: title })
    await row.locator('.task-body').click()
    await row.getByRole('button', { name: 'تعديل' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('radiogroup', { name: 'متى تريد تنفيذ المهمة؟' })).toBeVisible()
    await expect(dialog.getByText('الموعد النهائي (الاستحقاق)')).toBeVisible()
    await expect(dialog.getByText('النهاية', { exact: false }).first()).toBeVisible()
    await expect(dialog.getByRole('checkbox', { name: /هل لديك موعد نهائي لإنجاز المهمة/ })).toBeChecked()
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe('rtl')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    expect(await a11yViolations(page, 'dialog.sheet')).toEqual([])
  } finally { await cleanup(page, id) }
})
