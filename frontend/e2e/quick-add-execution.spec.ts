import { test, expect, noHorizontalOverflow, emptyDay, eveOf, removeBooked, zonedInstant } from './fixtures'
import { a11yViolations } from './axe'
import type { Locator, Page } from '@playwright/test'

/**
 * Quick Add says WHEN YOU WANT TO DO IT, like the task dialog: its day tiles book a calendar session at the dialog's default start and never
 * set a deadline; nothing is scheduled unless the user chooses. Real Laravel server, throwaway database, isolated e2e data only.
 *
 * The browser is in UTC and the account is not, so every time is the account's wall clock. The demo data has weekly events, so the days used
 * here are EMPTY days found at run time (never "in N days"); `eveOf` makes the app's "Tomorrow" mean such a day. Everything created is removed.
 */
test.use({ timezoneId: 'UTC' })

type Task = { id: number; title: string; due_at: string | null; estimated_minutes: number; schedule?: { starts_at: string; ends_at: string } | null }
async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body] as const)
}
const PREFIX = 'E2E quick-add-exec'
const stamp = (label: string) => `${PREFIX} ${label} ${Date.now()}`
const find = async (page: Page, title: string) => ((await call(page, 'GET', `/api/tasks?search=${encodeURIComponent(title)}&per_page=10`)).body?.data as Task[] ?? []).filter(t => t.title === title)
const accountZone = async (page: Page) => (await call(page, 'GET', '/api/settings')).body.timezone as string
async function cleanup(page: Page, titles: string[]) {
  await page.goto('/')
  for (const title of titles) for (const t of await find(page, title)) await removeBooked(page, t.id)
}
/** The deadline switch sits under "More options". */
async function deadlineSwitch(dialog: Locator) {
  await dialog.locator('summary', { hasText: 'More options' }).click()
  return dialog.getByRole('checkbox', { name: /deadline for finishing it/ })
}
const sheet = (page: Page) => page.getByRole('dialog', { name: /^Quick add$|^إضافة سريعة$/ })
async function openQuickAdd(page: Page) {
  await page.getByRole('button', { name: /^Quick add$|^إضافة سريعة$/ }).filter({ visible: true }).first().click()
  await expect(sheet(page)).toBeVisible()
  return sheet(page)
}
/** A task already booked at `start` for 30 minutes, to make that time taken. */
async function book(page: Page, title: string, start: string) {
  const r = await call(page, 'POST', '/api/tasks', { title, status: 'todo', estimated_minutes: 30, schedule: { starts_at: start } })
  expect(r.status).toBe(201)
}
/** An instant the way the server writes it (without milliseconds), for comparing. */
const iso = (at: string) => new Date(at).toISOString().replace('.000Z', 'Z')
const dayOf = (testInfo: { project: { name: string } }) => testInfo.project.name === 'mobile' ? 22 : 14

test('Tomorrow books 09:00–09:30 in one request, with no deadline, and the calendar and the list show it', async ({ page, setLanguage }, testInfo) => {
  await setLanguage('en')
  const day = await emptyDay(page, dayOf(testInfo)), zone = await accountZone(page), title = stamp('tomorrow')
  try {
    await eveOf(page, day)
    const requests: string[] = []
    page.on('request', r => { if (r.method() === 'POST' && /\/api\/tasks$/.test(r.url())) requests.push(r.postData() ?? '') })
    const quick = await openQuickAdd(page)
    await expect(quick.getByRole('radiogroup', { name: 'When do you want to do it?' }).getByRole('radio')).toHaveText([/Today/, /Tomorrow/, /Pick a date/, /Not scheduled/])
    await quick.getByRole('textbox', { name: 'Task' }).fill(title)
    await quick.getByRole('radio', { name: 'Tomorrow' }).click()
    await expect(quick.getByText(/Understood:/)).toHaveText('Understood: Tomorrow 09:00–09:30')
    await quick.getByRole('button', { name: 'Add task' }).click()
    await expect(page.getByText(/Added and scheduled: Tomorrow 09:00–09:30/)).toBeVisible()
    await expect(sheet(page)).toBeHidden()
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0])).toMatchObject({ title, estimated_minutes: 30, schedule: { starts_at: new Date(zonedInstant(`${day}T09:00`, zone)).toISOString() } })
    expect(JSON.parse(requests[0])).not.toHaveProperty('due_at')
    const [saved] = await find(page, title)
    expect(saved.due_at).toBeNull()
    expect(saved.schedule).toMatchObject({ starts_at: iso(zonedInstant(`${day}T09:00`, zone)), ends_at: iso(zonedInstant(`${day}T09:30`, zone)) })
    // The calendar has the session, and the list shows when it will be done.
    const occurrences = (await call(page, 'GET', `/api/calendar?from=${encodeURIComponent(`${day}T00:00:00Z`)}&to=${encodeURIComponent(`${day}T23:59:00Z`)}`)).body.data as { task_id: number | null; starts_at: string }[]
    expect(occurrences.filter(o => o.task_id === saved.id)).toHaveLength(1)
    await page.goto('/tasks')
    await expect(page.locator('.task-item', { hasText: title })).toContainText('09:00')
  } finally { await cleanup(page, [title]) }
})

test('the default is Not scheduled: the task has no calendar time and no deadline', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const title = stamp('default')
  try {
    await page.goto('/')
    const quick = await openQuickAdd(page)
    await expect(quick.getByRole('radio', { name: 'Not scheduled' })).toHaveAttribute('aria-checked', 'true')
    await quick.getByRole('textbox', { name: 'Task' }).fill(title)
    await expect(quick.getByText(/Understood:/)).toHaveCount(0)
    const sent = page.waitForRequest(r => r.method() === 'POST' && /\/api\/tasks$/.test(r.url()))
    await quick.getByRole('button', { name: 'Add task' }).click()
    const body = JSON.parse((await sent).postData() ?? '{}')
    for (const key of ['schedule', 'due_at', 'due_date']) expect(body).not.toHaveProperty(key)
    await expect(sheet(page)).toBeHidden()
    const [saved] = await find(page, title)
    expect(saved.due_at).toBeNull(); expect(saved.schedule ?? null).toBeNull()
  } finally { await cleanup(page, [title]) }
})

test('"tomorrow at 11am for one hour" is read as a start and a length, and wins over the chosen day', async ({ page, setLanguage }, testInfo) => {
  await setLanguage('en')
  const day = await emptyDay(page, dayOf(testInfo) + 2), zone = await accountZone(page), title = stamp('phrase') + ' tomorrow at 11am for one hour'
  try {
    await eveOf(page, day)
    const quick = await openQuickAdd(page)
    await quick.getByRole('radio', { name: 'Today' }).click()
    await quick.getByRole('textbox', { name: 'Task' }).fill(title)
    await expect(quick.getByText(/Understood:/)).toHaveText('Understood: Tomorrow 11:00–12:00')
    await quick.getByRole('button', { name: 'Add task' }).click()
    await expect(sheet(page)).toBeHidden()
    const [saved] = await find(page, title)
    expect(saved.due_at).toBeNull(); expect(saved.estimated_minutes).toBe(60)
    expect(saved.schedule).toMatchObject({ starts_at: iso(zonedInstant(`${day}T11:00`, zone)), ends_at: iso(zonedInstant(`${day}T12:00`, zone)) })
  } finally { await cleanup(page, [title]) }
})

test('a taken time saves nothing; the sheet stays; the suggested time saves once', async ({ page, setLanguage, guard }, testInfo) => {
  guard.allowConsole(/status of 42[29]/)
  await setLanguage('en')
  const day = await emptyDay(page, dayOf(testInfo) + 4), zone = await accountZone(page), blocker = stamp('blocker'), title = stamp('conflict')
  try {
    await book(page, blocker, zonedInstant(`${day}T09:00`, zone))
    await eveOf(page, day)
    const posts: string[] = []
    page.on('request', r => { if (r.method() === 'POST' && /\/api\/tasks$/.test(r.url())) posts.push(r.postData() ?? '') })
    const quick = await openQuickAdd(page)
    await quick.getByRole('textbox', { name: 'Task' }).fill(title)
    await quick.getByRole('radio', { name: 'Tomorrow' }).click()
    const refused = page.waitForResponse(r => r.request().method() === 'POST' && /\/api\/tasks$/.test(r.url()))
    await quick.getByRole('button', { name: 'Add task' }).click()
    expect((await refused).status()).toBe(422)
    // The server's own suggestion (it follows the working days, so on a weekend it is not simply the next half hour).
    const suggested = ((await (await refused).json()).conflict.suggestion as { starts_at: string }).starts_at
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText("You can't schedule this task from 09:00 to 09:30")
    expect(await a11yViolations(page, 'dialog.sc-dialog')).toEqual([])
    expect(await find(page, title)).toHaveLength(0)   // nothing was saved
    expect(posts).toHaveLength(1)
    // Still there, with the text.
    await expect(quick.getByRole('textbox', { name: 'Task' })).toHaveValue(title)
    await dialog.getByRole('button', { name: /Suggest the first free time/ }).dblclick()
    await expect(sheet(page)).toBeHidden()
    expect(posts).toHaveLength(2)
    const saved = await find(page, title)
    expect(saved).toHaveLength(1)
    expect(iso(saved[0].schedule!.starts_at)).toBe(iso(suggested))
    expect(iso(suggested)).not.toBe(iso(zonedInstant(`${day}T09:00`, zone)))
    expect(saved[0].due_at).toBeNull()
  } finally { await cleanup(page, [title, blocker]) }
})

test('"Choose another time" opens the full dialog with the same draft, the chosen day, start and length', async ({ page, setLanguage, guard }, testInfo) => {
  guard.allowConsole(/status of 42[29]/)
  await setLanguage('en')
  const day = await emptyDay(page, dayOf(testInfo) + 6), zone = await accountZone(page), blocker = stamp('blocker'), title = stamp('another')
  try {
    await book(page, blocker, zonedInstant(`${day}T09:00`, zone))
    await eveOf(page, day)
    const quick = await openQuickAdd(page)
    await quick.getByRole('textbox', { name: 'Task' }).fill(title)
    await quick.getByRole('radio', { name: 'Tomorrow' }).click()
    await quick.getByRole('button', { name: 'Add task' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Choose another time' }).click()
    const dialog = page.getByRole('dialog', { name: /Create item/ })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Title')).toHaveValue(title)
    await expect(dialog.getByRole('radio', { name: 'Tomorrow' })).toHaveAttribute('aria-checked', 'true')
    await expect(dialog.locator('label', { hasText: /^Start time/ }).locator('.dtp-trigger')).toContainText('09:00')
    await expect(await deadlineSwitch(dialog)).not.toBeChecked()
    expect(await find(page, title)).toHaveLength(0)
  } finally { await cleanup(page, [title, blocker]) }
})

test('More details opens prefilled (day, start, length), the deadline stays off, and Save books it', async ({ page, setLanguage }, testInfo) => {
  await setLanguage('en')
  const day = await emptyDay(page, dayOf(testInfo) + 8), zone = await accountZone(page), title = stamp('details') + ' for 45 minutes'
  try {
    await eveOf(page, day)
    const quick = await openQuickAdd(page)
    await quick.getByRole('textbox', { name: 'Task' }).fill(title)
    await quick.getByRole('radio', { name: 'Tomorrow' }).click()
    await quick.getByRole('button', { name: /More details/ }).click()
    const dialog = page.getByRole('dialog', { name: /Create item/ })
    await expect(dialog.getByLabel('Title')).toHaveValue(title)
    await expect(dialog.getByRole('radio', { name: 'Tomorrow' })).toHaveAttribute('aria-checked', 'true')
    await expect(dialog.locator('.rf-end')).toHaveText('Ends 09:45')
    await expect(await deadlineSwitch(dialog)).not.toBeChecked()
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toBeHidden()
    const [saved] = await find(page, title)
    expect(saved.due_at).toBeNull()
    expect(saved.schedule).toMatchObject({ starts_at: iso(zonedInstant(`${day}T09:00`, zone)), ends_at: iso(zonedInstant(`${day}T09:45`, zone)) })
  } finally { await cleanup(page, [title]) }
})

test('a double click on Add creates one task', async ({ page, setLanguage }, testInfo) => {
  await setLanguage('en')
  const day = await emptyDay(page, dayOf(testInfo) + 10), title = stamp('double')
  try {
    await eveOf(page, day)
    const quick = await openQuickAdd(page)
    await quick.getByRole('textbox', { name: 'Task' }).fill(title)
    await quick.getByRole('radio', { name: 'Tomorrow' }).click()
    await quick.getByRole('button', { name: 'Add task' }).dblclick()
    await expect(sheet(page)).toBeHidden()
    expect(await find(page, title)).toHaveLength(1)
  } finally { await cleanup(page, [title]) }
})

test('Arabic at 320px: the tiles, the understood line, the conflict-free save and axe', async ({ page, setLanguage }, testInfo) => {
  await setLanguage('ar')
  await page.setViewportSize({ width: 320, height: 640 })
  const day = await emptyDay(page, dayOf(testInfo) + 12), zone = await accountZone(page), title = stamp('arabic')
  try {
    await eveOf(page, day)
    const quick = await openQuickAdd(page)
    const group = quick.getByRole('radiogroup', { name: 'متى تريد تنفيذها؟' })
    await expect(group.getByRole('radio')).toHaveCount(4)
    await expect(group.getByRole('radio', { name: 'بدون جدولة' })).toHaveAttribute('aria-checked', 'true')
    await quick.getByRole('textbox', { name: 'المهمة' }).fill(`${title} بكرة الساعة 11 صباحا لمدة ساعة`)
    const line = quick.getByText(/فُهم:/)
    await expect(line).toHaveText('فُهم: غدًا 11:00–12:00')
    await expect(line.locator('bdi[dir="ltr"]')).toHaveText('11:00–12:00')
    await noHorizontalOverflow(page)
    for (const radio of await group.getByRole('radio').all()) { const b = (await radio.boundingBox())!; expect(b.height).toBeGreaterThanOrEqual(43.5); expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(320) }
    expect(await a11yViolations(page, 'dialog[open]')).toEqual([])
    await quick.getByRole('button', { name: 'إضافة المهمة' }).click()
    await expect(sheet(page)).toBeHidden()
    const [saved] = await find(page, `${title} بكرة الساعة 11 صباحا لمدة ساعة`)
    expect(saved.due_at).toBeNull()
    expect(saved.schedule?.starts_at).toBe(iso(zonedInstant(`${day}T11:00`, zone)))
  } finally { await cleanup(page, [`${title} بكرة الساعة 11 صباحا لمدة ساعة`]) }
})

test('keyboard: the day tiles are one radio group, Escape closes the sheet, the shortcut still opens it', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/?add=task')
  const quick = sheet(page)
  await expect(quick).toBeVisible()
  await expect(quick.getByRole('textbox', { name: 'Task' })).toBeFocused()
  const today = quick.getByRole('radio', { name: 'Today' })
  await today.focus(); await page.keyboard.press('Space')
  await expect(today).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(quick).toBeHidden()
  await expect(page).not.toHaveURL(/add=task/)
})

