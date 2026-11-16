import { test, expect } from './fixtures'
import { a11yViolations } from './axe'
import type { Page } from '@playwright/test'

/**
 * "Reorganize my day": preview, apply, undo. Real Laravel server and the shared demo account, so nothing here depends on the time of day or on
 * where the free slots are: the assertions are relationships (one session for the task, after now, overlapping nothing). When today has no
 * room the backend places the session on the next work day, which is accepted. Everything made here is removed in a `finally`.
 */
type Reply = { status: number; body: { data?: unknown } & Record<string, unknown> }
async function call(page: Page, method: string, path: string, body?: unknown): Promise<Reply> {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body] as const)
}
type Item = { event_id: number | null; task_id: number | null; title: string; starts_at: string; ends_at: string }
async function calendar(page: Page, from: Date, to: Date) {
  const r = await call(page, 'GET', `/api/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
  expect(r.status).toBe(200)
  return r.body.data as Item[]
}
const sessionsOf = async (page: Page, taskId: number) => (await calendar(page, new Date(Date.now() - 86_400_000), new Date(Date.now() + 20 * 86_400_000))).filter(o => o.task_id === taskId)

/** An open task due now (so "due today, without a session"), urgent so it is always among the first actions of the preview. */
async function makeTask(page: Page) {
  await page.goto('/')
  const title = `E2E reorganize ${Date.now()}`
  const made = await call(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'urgent', estimated_minutes: 30, due_at: new Date().toISOString() })
  expect(made.status).toBe(201)
  return { id: (made.body.data as { id: number }).id, title }
}
async function cleanup(page: Page, taskId: number, events: number[] = []) {
  for (const s of await sessionsOf(page, taskId)) if (s.event_id) await call(page, 'DELETE', `/api/events/${s.event_id}`)
  for (const id of events) await call(page, 'DELETE', `/api/events/${id}`)
  await call(page, 'DELETE', `/api/tasks/${taskId}`)
}
/** Leaves only this task's action ticked, so the demo account's other work is never touched. */
async function onlyThisTask(dialog: ReturnType<Page['getByRole']>, title: string) {
  const boxes = dialog.getByRole('checkbox')
  for (let i = 0, n = await boxes.count(); i < n; i++) {
    const box = boxes.nth(i), mine = (await box.locator('xpath=ancestor::label').textContent())?.includes(title)
    if (!mine && await box.isChecked()) await box.uncheck()
  }
}

test('slipped work: the card, the preview with reasons, Apply books exactly one session, Undo removes it', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const task = await makeTask(page)
  const started = Date.now()
  try {
    await page.goto('/')
    const card = page.getByRole('region', { name: 'Reorganize my day' })
    await expect(card).toContainText('Your day slipped')
    await expect(card).toContainText('without time')
    await card.getByRole('button', { name: 'Reorganize', exact: true }).click()

    const dialog = page.getByRole('dialog', { name: 'Reorganize my day' })
    const row = dialog.locator('li', { hasText: task.title })
    await expect(row).toBeVisible()
    await expect(row).toContainText('Due or overdue')
    await expect(row.locator('.move-detail')).not.toBeEmpty()
    await expect(row.locator('.proposal-time')).toContainText(/\d{2}:\d{2}–\d{2}:\d{2}/)
    // Previewing changed nothing.
    expect(await sessionsOf(page, task.id)).toHaveLength(0)

    await onlyThisTask(dialog, task.title)
    await dialog.getByRole('button', { name: /to calendar/ }).click()
    await expect(dialog.getByText('Applied', { exact: true })).toBeVisible()

    const sessions = await sessionsOf(page, task.id)
    expect(sessions).toHaveLength(1)
    const [start, end] = [Date.parse(sessions[0].starts_at), Date.parse(sessions[0].ends_at)]
    expect(start).toBeGreaterThanOrEqual(started - 60_000)
    const around = await calendar(page, new Date(start - 86_400_000), new Date(end + 86_400_000))
    for (const other of around.filter(o => o.task_id !== task.id && Date.parse(o.ends_at) - Date.parse(o.starts_at) < 20 * 3_600_000)) {
      expect(Date.parse(other.starts_at) >= end || Date.parse(other.ends_at) <= start, `overlaps "${other.title}"`).toBe(true)
    }
    // When it landed today, Today shows it without a reload.
    const zone = (await call(page, 'GET', '/api/settings')).body.timezone as string
    const day = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: zone })
    if (day(start) === day(Date.now())) await expect(page.locator(`a.strip-block[aria-label*="${task.title}"]`)).toHaveCount(1)

    await dialog.getByRole('button', { name: /Undo these changes/ }).click()
    await expect(page.getByText('All changes undone.')).toBeVisible()
    await expect.poll(async () => (await sessionsOf(page, task.id)).length).toBe(0)

    // Escape closes, and focus goes back to something that reopens the preview.
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator(':focus')).toHaveText(/Reorganize/)
  } finally { await cleanup(page, task.id) }
})

test('nothing has slipped: the summary and a Close button, and nothing is offered to apply', async ({ page, setLanguage }) => {
  await setLanguage('en')
  // The demo account is shared and may have slipped work of its own, so this answer is the documented "nothing to do" reply.
  await page.route('**/api/today/reorganize', route => route.request().method() === 'POST'
    ? route.fulfill({ json: { proposal: null, summary: 'Nothing has slipped: every task due today already has a session.', explanation: ['Your remaining time today is not overbooked.'] } })
    : route.continue())
  await page.goto('/')
  const opener = page.locator('[data-reorganize-open]').first()
  await opener.click()
  const dialog = page.getByRole('dialog', { name: 'Reorganize my day' })
  await expect(dialog).toContainText('Nothing has slipped')
  await expect(dialog).toContainText('not overbooked')
  await expect(dialog.getByRole('checkbox')).toHaveCount(0)
  expect(await a11yViolations(page, 'dialog[open]')).toEqual([])
  await dialog.getByRole('button', { name: 'Close' }).last().click()
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test('a slot taken meanwhile is refused on Apply with the conflict shown, and nothing is booked', async ({ page, setLanguage, guard }) => {
  guard.allowConsole(/status of 422/)
  await setLanguage('en')
  const task = await makeTask(page), events: number[] = []
  try {
    await page.goto('/')
    const reply = page.waitForResponse(r => r.url().endsWith('/api/today/reorganize') && r.request().method() === 'POST')
    await page.locator('[data-reorganize-open]').first().click()
    const proposal = (await (await reply).json()).proposal as { actions: { task_id: number; starts_at: string; ends_at: string }[] }
    const mine = proposal.actions.find(a => a.task_id === task.id)!
    const dialog = page.getByRole('dialog', { name: 'Reorganize my day' })
    await expect(dialog.locator('li', { hasText: task.title })).toBeVisible()
    const clash = await call(page, 'POST', '/api/events', { title: 'E2E takes the slot', starts_at: mine.starts_at, ends_at: mine.ends_at })
    expect(clash.status).toBe(201)
    events.push(((clash.body.data ?? clash.body) as { id: number }).id)

    await onlyThisTask(dialog, task.title)
    await dialog.getByRole('button', { name: /to calendar/ }).click()
    await expect(dialog.getByRole('alert')).not.toBeEmpty()
    expect(await sessionsOf(page, task.id)).toHaveLength(0)
    await dialog.getByRole('button', { name: 'Not now' }).click()
    await expect(dialog).toHaveCount(0)
  } finally { await cleanup(page, task.id, events) }
})

test('Arabic at 320 px: the entry and the preview do not overflow and have no accessibility violations', async ({ page, setLanguage }) => {
  await setLanguage('ar')
  const task = await makeTask(page)
  try {
    await page.setViewportSize({ width: 320, height: 800 })
    await page.goto('/')
    const card = page.getByRole('region', { name: 'أعد تنظيم يومي' })
    await expect(card).toContainText('انزلق يومك')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await card.getByRole('button', { name: 'أعد التنظيم' }).click()
    const dialog = page.getByRole('dialog', { name: 'أعد تنظيم يومي' })
    await expect(dialog.locator('li', { hasText: task.title })).toBeVisible()
    await expect(dialog.getByText('مستحقة أو متأخرة').first()).toBeVisible()
    expect(await page.evaluate(() => {
      const d = document.querySelector('dialog[open]')!, inner = d.querySelector('.sheet-inner')!
      return [document.documentElement.scrollWidth - document.documentElement.clientWidth, d.scrollWidth - d.clientWidth, inner.scrollWidth - inner.clientWidth]
    })).toEqual([0, 0, 0])
    expect(await a11yViolations(page, 'dialog[open]')).toEqual([])
    await dialog.getByRole('button', { name: 'ليس الآن' }).click()
    await expect(dialog).toHaveCount(0)
  } finally { await cleanup(page, task.id); await setLanguage('en') }
})
