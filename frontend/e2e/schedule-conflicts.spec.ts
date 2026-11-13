import { test, expect, field, pick, zonedInstant } from './fixtures'
import { a11yViolations } from './axe'
import type { Locator, Page } from '@playwright/test'

/**
 * Task scheduling from the edit dialog, and the "this time is already taken" answer. Real Laravel server, throwaway database, isolated
 * e2e data only: every task and session made here is removed at the end.
 *
 * The date fields, the sentences and the lists all use the ACCOUNT's timezone (the browser is in UTC here, to prove it): a typed 09:00 is
 * 09:00 account time, so every expected instant below is computed in that zone. The day is about three weeks ahead (not "tomorrow") so the demo data and another spec's "first free time"
 * bookings are not in the same hour.
 */
test.use({ timezoneId: 'UTC' })

type Reply = { status: number; body: { code?: string; timezone?: string; data?: unknown; conflict?: { code: string; conflicts: unknown[]; suggestion: { starts_at: string; ends_at: string } | null } } }
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
/** `pick` from the fixtures, with the picker's Arabic names (the fixture helper knows only the English ones). */
async function pickAr(page: Page, trigger: Locator, value: string) {
  await trigger.click()
  const sheet = page.locator('.dtp-dialog[open]'), [date, time] = value.includes('T') ? value.split('T') : /^\d{4}-/.test(value) ? [value, ''] : ['', value]
  await expect(sheet).toBeVisible()
  if (date) { const d = sheet.getByRole('textbox', { name: 'التاريخ' }); await d.fill(date); await d.press('Enter') }
  if (time) { const t = sheet.getByRole('textbox', { name: 'الوقت' }); await t.fill(time); await t.press('Enter') }
  await sheet.getByRole('button', { name: 'تم' }).click()
  await expect(sheet).toBeHidden()
}
/** The account's timezone, read by makeTask; `wall(day, '09:00')` is the instant at which the account's clock reads that time. */
let accountZone = 'Europe/Amsterdam'
const wall = (day: string, hm: string) => zonedInstant(`${day}T${hm}`, accountZone)
const clock = (at: string, zone: string) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone })
/**
 * A day, from about `n` days ahead, with nothing in the calendar between 08:00 and 12:00 (the demo data has events and weekly series);
 * the mobile project starts later, so the two projects do not pick the same day.
 */
async function freeDay(page: Page, n: number, mobile: boolean) {
  await page.goto('/')
  for (let i = n + (mobile ? 8 : 0); i < n + 40; i++) {
    const day = new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10)
    const r = await call(page, 'GET', `/api/calendar?from=${encodeURIComponent(`${day}T06:00:00Z`)}&to=${encodeURIComponent(`${day}T14:00:00Z`)}`)
    if (r.status === 200 && (r.body.data as unknown[]).length === 0) return day
  }
  throw new Error('no free day found')
}

async function makeTask(page: Page, label: string) {
  await page.goto('/')
  const zone = (await call(page, 'GET', '/api/settings')).body.timezone as string
  accountZone = zone
  const title = `E2E conflict ${label} ${Date.now()}`
  const due = new Date(Math.floor((Date.now() + 10 * 86_400_000) / 60_000) * 60_000).toISOString()   // whole minutes: the dialog's date field has no seconds
  const made = await call(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'medium', estimated_minutes: 30, due_at: due })
  expect(made.status).toBe(201)
  return { id: (made.body.data as { id: number }).id, title, zone, due }
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
  const dialog = page.getByRole('dialog', { name: /Edit item|تعديل العنصر/ })
  await expect(dialog).toBeVisible()
  return dialog
}
/** The saves of a task that carry a `schedule` (the dialog's one request): POST /api/tasks or PATCH /api/tasks/{id}. */
const scheduleCalls = (page: Page, seen: { method: string; key: string }[]) => page.on('request', r => { if (/\/api\/tasks(\/\d+)?$/.test(r.url()) && ['POST', 'PATCH'].includes(r.method()) && (r.postData() ?? '').includes('"schedule"')) seen.push({ method: r.method(), key: r.headers()['idempotency-key'] ?? '' }) })
const dayTile = (dialog: Locator) => dialog.getByRole('radio', { name: /^Pick a date|^تاريخ آخر/ })

test('schedule from the edit dialog, move it once, then a taken time is refused with a clear dialog and a free time works', async ({ page, setLanguage, guard }, testInfo) => {
  guard.allowConsole(/status of 42[29]/)   // the refused overlap is the point of this test
  await setLanguage('en')
  const first = await makeTask(page, 'a'), second = await makeTask(page, 'b')
  const day = await freeDay(page, 22, testInfo.project.name === 'mobile')
  try {
    const seen: { method: string; key: string }[] = []
    scheduleCalls(page, seen)

    // 1-3. A 30-minute task, scheduled at 09:00 from the dialog: one POST, one session, drawn once in the calendar.
    let dialog = await openDialog(page, first.title)
    await expect(dialog.getByRole('radio', { name: 'Not scheduled' })).toHaveAttribute('aria-checked', 'true')
    await pick(page, dayTile(dialog), day); await pick(page, field(dialog, 'Start time'), '09:00')
    await expect(dialog.locator('.rf-end')).toHaveText('Ends 09:30')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    expect(seen).toHaveLength(1); expect(seen[0].key).toMatch(/^[0-9a-f-]{36}$/)
    const created = await sessionsOf(page, first.id)
    expect(created).toHaveLength(1)
    expect(Date.parse(created[0].starts_at)).toBe(Date.parse(wall(day, '09:00'))); expect(Date.parse(created[0].ends_at)).toBe(Date.parse(wall(day, '09:30')))
    const eventId = created[0].event_id as number
    await page.goto(`/calendar?date=${day}`)
    await expect(page.locator('[data-session]', { hasText: first.title })).toHaveCount(1)

    // 4-6. Open the task again, move the start to 10:00 with Save (a double click): one PUT, the same session, the old block is gone.
    dialog = await openDialog(page, first.title)
    await expect(field(dialog, 'Start time')).toHaveAttribute('data-value', clock(created[0].starts_at, first.zone))
    await pick(page, field(dialog, 'Start time'), '10:00')
    const moved = page.waitForResponse(r => /\/api\/tasks\/\d+$/.test(r.url()) && r.request().method() === 'PATCH')
    await dialog.getByRole('button', { name: 'Save' }).dblclick()
    expect((await moved).status()).toBe(200)
    await expect(dialog).toBeHidden()
    await page.waitForTimeout(400)
    expect(seen.filter(c => c.method === 'PATCH')).toHaveLength(2)   // the first booking and this move: one request each
    const afterMove = await sessionsOf(page, first.id)
    expect(afterMove).toHaveLength(1); expect(afterMove[0].event_id).toBe(eventId)
    expect(Date.parse(afterMove[0].starts_at)).toBe(Date.parse(wall(day, '10:00'))); expect(Date.parse(afterMove[0].ends_at)).toBe(Date.parse(wall(day, '10:30')))
    // The deadline did not move with the session.
    const read = await call(page, 'GET', `/api/tasks/${first.id}`)
    expect(Date.parse((read.body.data as { due_at: string }).due_at)).toBe(Date.parse(first.due))

    // 7. Reloaded: still 10:00, one block.
    await page.goto(`/calendar?date=${day}`)
    await page.reload()
    await expect(page.locator('[data-session]', { hasText: first.title })).toHaveCount(1)
    expect(await sessionsOf(page, first.id)).toHaveLength(1)

    // 8-10. A second task, 09:45 to 10:15: the server says no, the dialog explains, nothing is created, the edit dialog stays open.
    dialog = await openDialog(page, second.title)
    await pick(page, dayTile(dialog), day); await pick(page, field(dialog, 'Start time'), '09:45')
    await dialog.getByRole('button', { name: 'Save' }).click()
    const alert = page.getByRole('alertdialog')
    await expect(alert).toBeVisible()
    await expect(alert.getByRole('heading')).toHaveText('This time is already booked for another task.')
    const asked = [wall(day, '09:45'), wall(day, '10:15')].map(at => clock(at, second.zone)), other = [wall(day, '10:00'), wall(day, '10:30')].map(at => clock(at, first.zone))
    await expect(alert).toContainText(`You can't schedule this task from ${asked[0]} to ${asked[1]}, because you already have another task from ${other[0]} to ${other[1]}.`)
    await expect(alert).toContainText(first.title); await expect(alert).toContainText('15 min overlap')
    await expect(alert.getByRole('link', { name: 'View the conflicting item' })).toHaveAttribute('href', new RegExp(`/calendar\\?date=\\d{4}-\\d{2}-\\d{2}&session=${eventId}`))
    expect(await a11yViolations(page, 'dialog.sc-dialog')).toEqual([])
    expect(await sessionsOf(page, second.id)).toHaveLength(0)
    await expect(dialog).toBeVisible()

    // Escape closes only the conflict dialog and focus is back on Save; the edit dialog stays.
    await page.keyboard.press('Escape')
    await expect(alert).toBeHidden(); await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeFocused()

    // 11. Take the first free time the server suggests: success, one session, no overlap with the first task.
    await dialog.getByRole('button', { name: 'Save' }).click()
    const suggest = page.getByRole('alertdialog').getByRole('button', { name: /Suggest the first free time/ })
    await expect(suggest).toBeVisible()
    await suggest.click()
    await expect(dialog).toBeHidden()
    const placed = await sessionsOf(page, second.id)
    expect(placed).toHaveLength(1)
    expect(Date.parse(placed[0].starts_at) >= Date.parse(wall(day, '10:30')) || Date.parse(placed[0].ends_at) <= Date.parse(wall(day, '10:00'))).toBe(true)
    expect(seen).toHaveLength(5)   // first booking, the move, the refused try, the same try again after Escape, the suggestion
    expect(await sessionsOf(page, first.id)).toHaveLength(1)
  } finally { await cleanup(page, second.id); await cleanup(page, first.id) }
})

test('the server answers an overlapping booking with a 422 conflict and creates nothing (contract)', async ({ page, guard }, testInfo) => {
  guard.allowConsole(/status of 42[29]/)
  const first = await makeTask(page, 'c'), second = await makeTask(page, 'd')
  const day = await freeDay(page, 25, testInfo.project.name === 'mobile')
  try {
    expect((await call(page, 'POST', `/api/tasks/${first.id}/schedule`, { starts_at: wall(day, '09:00'), ends_at: wall(day, '09:30') }, { 'Idempotency-Key': crypto.randomUUID() })).status).toBe(201)
    const refused = await call(page, 'POST', `/api/tasks/${second.id}/schedule`, { starts_at: wall(day, '09:15'), ends_at: wall(day, '09:45') }, { 'Idempotency-Key': crypto.randomUUID() })
    expect(refused.status).toBe(422)
    expect(refused.body.conflict?.code).toBe('schedule_conflict')
    expect(refused.body.conflict?.conflicts.length).toBeGreaterThan(0)
    expect(await sessionsOf(page, second.id)).toHaveLength(0)
  } finally { await cleanup(page, second.id); await cleanup(page, first.id) }
})

test('the conflict dialog reads right in Arabic and fits a 320px screen', async ({ page, setLanguage, guard }, testInfo) => {
  guard.allowConsole(/status of 42[29]/)
  await setLanguage('ar')
  await page.setViewportSize({ width: 320, height: 640 })
  const first = await makeTask(page, 'e'), second = await makeTask(page, 'f')
  const day = await freeDay(page, 28, testInfo.project.name === 'mobile')
  try {
    expect((await call(page, 'POST', `/api/tasks/${first.id}/schedule`, { starts_at: wall(day, '09:00'), ends_at: wall(day, '09:30') }, { 'Idempotency-Key': crypto.randomUUID() })).status).toBe(201)
    const dialog = await openDialog(page, second.title)
    await pickAr(page, dayTile(dialog), day); await pickAr(page, field(dialog, 'وقت البداية'), '09:15')
    await dialog.getByRole('button', { name: 'حفظ' }).click()
    const alert = page.getByRole('alertdialog')
    await expect(alert.getByRole('heading')).toHaveText('هذا الوقت محجوز بالفعل لمهمة أخرى.')
    await expect(alert).toContainText('لا يمكن جدولة هذه المهمة من')
    await expect(alert).toContainText('تداخل 15 دقيقة')
    await expect(alert.getByRole('button', { name: 'اختيار وقت آخر' })).toBeFocused()
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe('rtl')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    expect(await a11yViolations(page, 'dialog.sc-dialog')).toEqual([])
    await alert.getByRole('button', { name: 'اختيار وقت آخر' }).click()
    await expect(alert).toBeHidden()
    await expect(field(dialog, 'وقت البداية')).toBeFocused()
    expect(await sessionsOf(page, second.id)).toHaveLength(0)
  } finally { await cleanup(page, second.id); await cleanup(page, first.id) }
})

test('a time that was free in the choices but is taken when tapped opens the conflict dialog from the calendar session panel', async ({ page, setLanguage, guard }, testInfo) => {
  guard.allowConsole(/status of 42[29]/)
  await setLanguage('en')
  const first = await makeTask(page, 'g'), blockers: number[] = []
  const day = await freeDay(page, 12, testInfo.project.name === 'mobile')
  try {
    const booked = await call(page, 'POST', `/api/tasks/${first.id}/schedule`, { starts_at: wall(day, '09:00'), ends_at: wall(day, '09:30') }, { 'Idempotency-Key': crypto.randomUUID() })
    expect(booked.status).toBe(201)
    const eventId = (booked.body.data as { id: number }).id
    await page.goto(`/calendar?date=${day}`)
    await page.locator(`[data-session="${eventId}"]`).click()
    const panel = page.getByRole('region', { name: 'Task session' })
    await panel.getByRole('button', { name: 'Reschedule' }).click()
    const chips = panel.getByRole('group', { name: 'Reschedule' })
    await expect(chips.locator('button.filter-chip').first()).toBeVisible()
    // Something else takes every free stretch of the coming week after the choices were drawn (another tab, another device).
    const free = await call(page, 'GET', `/api/availability?date=${new Date().toISOString().slice(0, 10)}&days=7&min_minutes=30`)
    const days = (free.body as unknown as { days: { slots: { starts_at: string; ends_at: string }[] }[] }).days
    for (const slot of days.flatMap(d => d.slots)) {
      const made = await call(page, 'POST', '/api/events', { title: `E2E blocker ${Date.now()}`, kind: 'fixed', starts_at: slot.starts_at, ends_at: slot.ends_at })
      if (made.status === 201) blockers.push((made.body.data as { id: number }).id)
    }
    expect(blockers.length).toBeGreaterThan(0)
    await chips.locator('button.filter-chip').first().click()
    const alert = page.getByRole('alertdialog')
    await expect(alert).toBeVisible()
    await expect(alert.getByRole('heading')).toContainText('already booked')
    // Nothing moved.
    const now = await sessionsOf(page, first.id)
    expect(now).toHaveLength(1); expect(Date.parse(now[0].starts_at)).toBe(Date.parse(wall(day, '09:00')))
    await alert.getByRole('button', { name: 'Choose another time' }).click()
    await expect(alert).toBeHidden()
    await expect(panel).toBeVisible()
    await expect(chips.locator('button').first()).toBeFocused()
  } finally {
    for (const id of blockers) await call(page, 'DELETE', `/api/events/${id}`)
    await cleanup(page, first.id)
  }
})
