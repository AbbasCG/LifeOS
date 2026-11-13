import { test, expect, field, pick, zonedInstant, noHorizontalOverflow } from './fixtures'
import { a11yViolations } from './axe'
import type { Locator, Page } from '@playwright/test'

/**
 * Smart one-step scheduling: a task is placed in the calendar from the task dialog with ONE Save (one request), with no deadline,
 * no typed end time and no separate "Schedule" button. Real Laravel server, throwaway database; every task and session made here is removed
 * at the end. The browser is in Los Angeles while the account clock is Amsterdam's, so every time below proves the account clock is used.
 * Days are found with `freeDay` (the demo data has weekly events), never "in N days".
 */
test.use({ timezoneId: 'America/Los_Angeles' })

type Reply = { status: number; body: { code?: string; timezone?: string; data?: unknown; conflict?: { suggestion: { starts_at: string } | null } } }
async function call(page: Page, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return page.evaluate(async ([m, p, b, h]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token, ...(h as Record<string, string>) }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body, headers] as const)
}
type Occurrence = { event_id: number | null; task_id: number | null; starts_at: string; ends_at: string }
async function sessionsOf(page: Page, taskId: number) {
  const from = new Date(Date.now() - 86_400_000).toISOString(), to = new Date(Date.now() + 60 * 86_400_000).toISOString()
  const r = await call(page, 'GET', `/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
  expect(r.status).toBe(200)
  return (r.body.data as unknown as Occurrence[]).filter(o => o.task_id === taskId)
}
type TaskRow = { id: number; title: string; due_at: string | null; due_all_day?: boolean; estimated_minutes: number; schedule: { starts_at: string; ends_at: string } | null }
const tasksTitled = async (page: Page, title: string) => ((await call(page, 'GET', `/api/tasks?search=${encodeURIComponent(title)}`)).body.data as TaskRow[]).filter(t => t.title === title)
/** The first day from about five days ahead with nothing in the calendar between 06:00 and 18:00 UTC (covers 09:00-19:00 in the account zone). Every test removes what it made, so they can share it. */
async function freeDay(page: Page) {
  await page.goto('/')
  for (let i = 5; i < 55; i++) {
    const day = new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10)
    const r = await call(page, 'GET', `/api/calendar?from=${encodeURIComponent(`${day}T06:00:00Z`)}&to=${encodeURIComponent(`${day}T18:00:00Z`)}`)
    if (r.status === 200 && (r.body.data as unknown[]).length === 0) return day
  }
  throw new Error('no free day found')
}
let zone = 'Europe/Amsterdam'
const wall = (day: string, hm: string) => zonedInstant(`${day}T${hm}`, zone)
const makeApiTask = async (page: Page, label: string, extra: Record<string, unknown> = {}) => {
  await page.goto('/')
  zone = (await call(page, 'GET', '/api/settings')).body.timezone as string
  const title = `E2E smart ${label} ${Date.now()}`
  const made = await call(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'medium', estimated_minutes: 30, ...extra })
  expect(made.status).toBe(201)
  return { id: (made.body.data as { id: number }).id, title }
}
async function cleanup(page: Page, ...ids: number[]) {
  for (const id of ids) {
    for (const s of await sessionsOf(page, id)) if (s.event_id) await call(page, 'DELETE', `/api/events/${s.event_id}`)
    await call(page, 'DELETE', `/api/tasks/${id}`)
  }
}
async function openEdit(page: Page, title: string, name = /Edit item|تعديل العنصر/) {
  await page.goto('/tasks')
  const row = page.locator('.task-item', { hasText: title })
  if ((await row.locator('.task-body').getAttribute('aria-expanded')) !== 'true') await row.locator('.task-body').click()
  await row.getByRole('button', { name: /^Edit|^تعديل/ }).click()
  const dialog = page.getByRole('dialog', { name })
  await expect(dialog).toBeVisible()
  return dialog
}
/** The full new-task dialog: Quick Add (with "No date", so no deadline is pre-filled) then "More details". */
async function openNew(page: Page, title: string) {
  await page.goto('/tasks')
  await page.getByRole('button', { name: 'Add task' }).first().click()
  const quick = page.getByRole('dialog', { name: 'Quick add' })
  await quick.getByLabel('Task').fill(title)
  await quick.getByRole('radio', { name: 'No date' }).click()
  await quick.getByRole('button', { name: 'More details' }).click()
  const dialog = page.getByRole('dialog', { name: /Create item/ })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Title')).toHaveValue(title)
  return dialog
}
const dayTile = (dialog: Locator) => dialog.getByRole('radio', { name: /^Pick a date/ })
const start = (dialog: Locator) => field(dialog, 'Start time')
const endLine = (dialog: Locator) => dialog.locator('.rf-end')
const save = (dialog: Locator) => dialog.getByRole('button', { name: 'Save' })

test('the acceptance flow: a new 15-minute task, 15:30, one Save, it is in the calendar with no deadline; then edit start, length, remove', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const day = await freeDay(page)
  const title = `E2E smart new ${Date.now()}`
  let id = 0
  try {
    const requests: string[] = []
    page.on('request', r => { if (r.method() !== 'GET' && /\/api\//.test(r.url())) requests.push(`${r.method()} ${new URL(r.url()).pathname}`) })
    const dialog = await openNew(page, title)
    await expect(dialog.getByRole('radio', { name: 'Not scheduled' })).toHaveAttribute('aria-checked', 'true')   // nothing is scheduled by default
    await expect(dialog.getByText(/Estimate|Scheduled execution|Execution end/)).toHaveCount(0)              // no second length field, no typed end
    await pick(page, dayTile(dialog), day)
    await expect(dayTile(dialog)).toHaveAttribute('aria-checked', 'true')
    await pick(page, start(dialog), '15:30')
    await dialog.getByRole('radio', { name: '15', exact: true }).click()
    await expect(endLine(dialog)).toHaveText('Ends 15:45')
    await expect(dialog.getByText('Saving puts it in your calendar.')).toBeVisible()
    const created = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'POST')
    await save(dialog).click()
    expect((await created).status()).toBe(201)
    await expect(dialog).toBeHidden()
    expect(requests.filter(r => r.startsWith('POST /api/tasks'))).toEqual(['POST /api/tasks'])   // ONE request: no /schedule call, no second PATCH
    expect(requests.some(r => /\/schedule$/.test(r))).toBe(false)

    const [task] = await tasksTitled(page, title); id = task.id
    expect(task.due_at).toBeNull(); expect(task.estimated_minutes).toBe(15)
    const [session] = await sessionsOf(page, id)
    expect(await sessionsOf(page, id)).toHaveLength(1)
    expect(Date.parse(session.starts_at)).toBe(Date.parse(wall(day, '15:30'))); expect(Date.parse(session.ends_at)).toBe(Date.parse(wall(day, '15:45')))
    await page.goto(`/calendar?date=${day}`)
    await expect(page.locator('[data-session]', { hasText: title })).toHaveCount(1)
    await page.goto('/tasks')
    const row = page.locator('.task-item', { hasText: title })
    await expect(row.locator('.sched-badge')).toContainText('15:30'); await expect(row.locator('.sched-badge')).toContainText('15:45'); await expect(row.locator('.due')).toHaveCount(0)

    // Reload: the dialog shows the same state. Edit the start: the end follows, the SAME session moves.
    let edit = await openEdit(page, title)
    await expect(start(edit)).toHaveAttribute('data-value', '15:30'); await expect(endLine(edit)).toHaveText('Ends 15:45'); await expect(edit.getByRole('radio', { name: '15', exact: true })).toHaveAttribute('aria-checked', 'true')
    await pick(page, start(edit), '16:00'); await expect(endLine(edit)).toHaveText('Ends 16:15')
    await save(edit).dblclick(); await expect(edit).toBeHidden()
    let after = await sessionsOf(page, id)
    expect(after).toHaveLength(1); expect(after[0].event_id).toBe(session.event_id)
    expect(Date.parse(after[0].starts_at)).toBe(Date.parse(wall(day, '16:00'))); expect(Date.parse(after[0].ends_at)).toBe(Date.parse(wall(day, '16:15')))

    // Length 30: the end is 16:30 and the estimate follows.
    edit = await openEdit(page, title)
    await edit.getByRole('radio', { name: '30', exact: true }).click(); await expect(endLine(edit)).toHaveText('Ends 16:30')
    await save(edit).click(); await expect(edit).toBeHidden()
    after = await sessionsOf(page, id)
    expect(after).toHaveLength(1); expect(Date.parse(after[0].ends_at)).toBe(Date.parse(wall(day, '16:30')))
    expect((await tasksTitled(page, title))[0].estimated_minutes).toBe(30)

    // «Not scheduled» removes the session in plain words, the task stays, Undo puts it back.
    edit = await openEdit(page, title)
    await edit.getByRole('radio', { name: 'Not scheduled' }).click()
    await expect(edit.getByText(/Saving will remove it from your calendar/)).toBeVisible()
    await save(edit).click(); await expect(edit).toBeHidden()
    expect(await sessionsOf(page, id)).toHaveLength(0); expect(await tasksTitled(page, title)).toHaveLength(1)
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(async () => (await sessionsOf(page, id)).length).toBe(1)
  } finally { if (id) await cleanup(page, id) }
})

test('a new task saved with no schedule is just a task: no session, no deadline, not in the calendar', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/')
  const title = `E2E smart none ${Date.now()}`
  let id = 0
  try {
    const dialog = await openNew(page, title)
    await expect(dialog.getByRole('checkbox', { name: /Do you have a deadline/ })).not.toBeChecked().catch(async () => { await dialog.getByText('More options').click(); await expect(dialog.getByRole('checkbox', { name: /Do you have a deadline/ })).not.toBeChecked() })
    await save(dialog).click(); await expect(dialog).toBeHidden()
    const [task] = await tasksTitled(page, title); id = task.id
    expect(task.due_at).toBeNull(); expect(task.schedule).toBeNull(); expect(await sessionsOf(page, id)).toHaveLength(0)
  } finally { if (id) await cleanup(page, id) }
})

test('a taken time: the conflict dialog, nothing saved, the dialog keeps its input; a free time then saves', async ({ page, setLanguage, guard }) => {
  guard.allowConsole(/status of 42[29]/)
  await setLanguage('en')
  const day = await freeDay(page)
  const first = await makeApiTask(page, 'a'), second = await makeApiTask(page, 'b')
  try {
    expect((await call(page, 'POST', `/api/tasks/${first.id}/schedule`, { starts_at: wall(day, '10:00'), ends_at: wall(day, '10:30') }, { 'Idempotency-Key': crypto.randomUUID() })).status).toBe(201)
    const dialog = await openEdit(page, second.title)
    await pick(page, dayTile(dialog), day); await pick(page, start(dialog), '10:15')
    await dialog.getByRole('radio', { name: '15', exact: true }).click()
    await save(dialog).click()
    const alert = page.getByRole('alertdialog')
    await expect(alert.getByRole('heading')).toHaveText('This time is already booked for another task.')
    await expect(alert).toContainText(first.title); await expect(alert).toContainText('5 min overlap')
    expect(await a11yViolations(page, 'dialog.sc-dialog')).toEqual([])
    expect(await sessionsOf(page, second.id)).toHaveLength(0)
    await expect(dialog).toBeVisible(); await expect(dialog.getByLabel('Title')).toHaveValue(second.title)
    // Choose another time: focus goes to the start field; a free time saves in one request.
    await alert.getByRole('button', { name: 'Choose another time' }).click()
    await expect(start(dialog)).toBeFocused()
    await pick(page, start(dialog), '12:00'); await expect(endLine(dialog)).toHaveText('Ends 12:15')
    await save(dialog).click(); await expect(dialog).toBeHidden()
    const placed = await sessionsOf(page, second.id)
    expect(placed).toHaveLength(1); expect(Date.parse(placed[0].starts_at)).toBe(Date.parse(wall(day, '12:00')))
    expect(await sessionsOf(page, first.id)).toHaveLength(1)
  } finally { await cleanup(page, second.id, first.id) }
})

test('the suggested time of the conflict dialog is applied by the dialog and saved once', async ({ page, setLanguage, guard }) => {
  guard.allowConsole(/status of 42[29]/)
  await setLanguage('en')
  const day = await freeDay(page)
  const first = await makeApiTask(page, 'c'), second = await makeApiTask(page, 'd')
  try {
    expect((await call(page, 'POST', `/api/tasks/${first.id}/schedule`, { starts_at: wall(day, '10:00'), ends_at: wall(day, '10:30') }, { 'Idempotency-Key': crypto.randomUUID() })).status).toBe(201)
    const dialog = await openEdit(page, second.title)
    await pick(page, dayTile(dialog), day); await pick(page, start(dialog), '10:15')
    await save(dialog).click()
    await page.getByRole('alertdialog').getByRole('button', { name: /Suggest the first free time/ }).click()
    await expect(dialog).toBeHidden()
    const placed = await sessionsOf(page, second.id)
    expect(placed).toHaveLength(1)
    expect(Date.parse(placed[0].starts_at) >= Date.parse(wall(day, '10:30')) || Date.parse(placed[0].ends_at) <= Date.parse(wall(day, '10:00'))).toBe(true)
  } finally { await cleanup(page, second.id, first.id) }
})

test('the deadline is separate: an old deadline is kept when only the execution time changes, and it can be removed on purpose', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const day = await freeDay(page)
  await page.goto('/')
  const due = wall(day, '17:00')
  const { id, title } = await makeApiTask(page, 'due', { due_at: due })
  try {
    let dialog = await openEdit(page, title)
    await expect(dialog.getByRole('checkbox', { name: /Do you have a deadline/ })).toBeChecked()
    await expect(dialog.locator('.rf-deadline .dtp-trigger')).toHaveAttribute('data-value', `${day}T17:00`)
    await pick(page, dayTile(dialog), day); await pick(page, start(dialog), '09:00')
    await save(dialog).click(); await expect(dialog).toBeHidden()
    const [kept] = await tasksTitled(page, title)
    expect(Date.parse(kept.due_at!)).toBe(Date.parse(due)); expect(await sessionsOf(page, id)).toHaveLength(1)
    dialog = await openEdit(page, title)
    await dialog.getByRole('checkbox', { name: /Do you have a deadline/ }).uncheck()
    await expect(dialog.getByText('Saving will remove the deadline.')).toBeVisible()
    await save(dialog).click(); await expect(dialog).toBeHidden()
    expect((await tasksTitled(page, title))[0].due_at).toBeNull(); expect(await sessionsOf(page, id)).toHaveLength(1)   // the session is untouched
  } finally { await cleanup(page, id) }
})

test('rapid double Save creates one task and one session', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const day = await freeDay(page)
  const title = `E2E smart rapid ${Date.now()}`
  let ids: number[] = []
  try {
    const dialog = await openNew(page, title)
    await pick(page, dayTile(dialog), day); await pick(page, start(dialog), '14:00')
    await save(dialog).dblclick(); await expect(dialog).toBeHidden()
    ids = (await tasksTitled(page, title)).map(t => t.id)
    expect(ids).toHaveLength(1); expect(await sessionsOf(page, ids[0])).toHaveLength(1)
  } finally { await cleanup(page, ...ids) }
})

test('Arabic, right to left, 24-hour, keyboard and 320px: the question, the tiles, the end line, and no accessibility violations', async ({ page, setLanguage }) => {
  await setLanguage('ar')
  await page.setViewportSize({ width: 320, height: 700 })
  const { id, title } = await makeApiTask(page, 'rtl')
  try {
    const dialog = await openEdit(page, title, /تعديل العنصر/)
    await expect(dialog.getByRole('radiogroup', { name: 'متى تريد تنفيذ المهمة؟' })).toBeVisible()
    for (const name of ['اليوم', 'غدًا', 'تاريخ آخر', 'بدون جدولة']) await expect(dialog.getByRole('radio', { name: new RegExp(`^${name}`) })).toBeVisible()
    await dialog.getByRole('radio', { name: 'غدًا' }).focus(); await page.keyboard.press('Space')
    await expect(dialog.getByRole('radio', { name: 'غدًا' })).toHaveAttribute('aria-checked', 'true')
    const time = field(dialog, 'وقت البداية')
    await expect(time).toBeVisible(); expect(await time.textContent()).toMatch(/^\s*\d{2}:\d{2}\s*$/)   // 24-hour
    await dialog.getByRole('radio', { name: '15', exact: true }).click()
    await expect(dialog.locator('.rf-end')).toContainText(/النهاية\s*\d{2}:\d{2}/)
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe('rtl')
    await noHorizontalOverflow(page)
    expect(await a11yViolations(page, 'dialog.sheet')).toEqual([])
  } finally { await cleanup(page, id) }
})
