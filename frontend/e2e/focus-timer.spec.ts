import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'

/**
 * The focus timer against the real server. "Time passing" is simulated by moving the running session's start back in the server's
 * database (the server's clock is what decides), and the page then behaves exactly as it would after that much real time.
 */
const api = (page: Page, method: string, path: string, body?: unknown) => page.evaluate(async ([m, p, b]) => {
  const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
  const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
}, [method, path, body] as const)

type S = { id: number; status: string; elapsed_seconds: number; duration_seconds: number; task_id: number | null; mode: string | null }
const sessions = async (page: Page) => ((await api(page, 'GET', '/api/focus-sessions')).body as { data: S[] }).data
const active = async (page: Page) => (await sessions(page)).find(s => s.status === 'running' || s.status === 'paused')
const maxId = async (page: Page) => Math.max(0, ...(await sessions(page)).map(s => s.id))
const addedSince = async (page: Page, id: number) => (await sessions(page)).filter(s => s.id > id)
const newest = async (page: Page) => (await sessions(page)).reduce((a, b) => (b.id > a.id ? b : a))
const seconds = async (page: Page) => { const [a, b, c] = (await page.locator('.dial-time').innerText()).split(':').map(Number); return c === undefined ? a * 60 + b : a * 3600 + b * 60 + c }

function moveTimeForward(seconds: number) {
  const db = process.env.E2E_DB!
  const sql = `UPDATE focus_sessions SET resumed_at = datetime(resumed_at, '-${seconds} seconds'), started_at = datetime(started_at, '-${seconds} seconds'), updated_at = datetime(updated_at, '-${seconds} seconds'), created_at = datetime(created_at, '-${seconds} seconds') WHERE status = 'running'`
  execFileSync('php', ['-r', `$p = new PDO('sqlite:' . $argv[1]); $p->exec($argv[2]);`, db, sql])
}

function setEstimate(id: number, minutes: number) {
  execFileSync('php', ['-r', `$p = new PDO('sqlite:' . $argv[1]); $p->exec($argv[2]);`, process.env.E2E_DB!, `UPDATE tasks SET estimated_minutes = ${minutes} WHERE id = ${id}`])
}

async function clean(page: Page) {
  for (const s of await sessions(page)) if (s.status === 'running' || s.status === 'paused') await api(page, 'PATCH', `/api/focus-sessions/${s.id}`, { action: 'cancel' })
}

test.beforeEach(async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.evaluate(() => localStorage.setItem('lifeos-language', 'en'))
  await clean(page)
})
test.afterEach(async ({ page }) => { await clean(page).catch(() => undefined) })

test('Start counts down at once, and a page refresh keeps the time that is really left', async ({ page }) => {
  await page.goto('/focus')
  await page.locator('.focus-start').click()
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible()
  expect(await seconds(page)).toBeGreaterThan(24 * 60 + 50)
  await expect.poll(() => seconds(page), { timeout: 8000 }).toBeLessThan(25 * 60 - 2)
  moveTimeForward(600)
  await page.reload()
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible()
  const left = await seconds(page)
  expect(left, 'about 15 minutes left, not restarted and not finished').toBeGreaterThan(14 * 60)
  expect(left).toBeLessThan(15 * 60 + 5)
  expect((await active(page))!.status).toBe('running')
  await expect(page.getByText('This session ended while you were away.')).toHaveCount(0)
})

test('two quick taps on Start create one session', async ({ page, guard }) => {
  guard.allowConsole(/422/)
  await page.goto('/focus')
  await page.locator('.focus-start').dblclick()
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible()
  const all = (await sessions(page)).filter(s => s.status === 'running' || s.status === 'paused')
  expect(all).toHaveLength(1)
  expect((await api(page, 'POST', '/api/focus-sessions', { kind: 'focus', duration_seconds: 1500 })).status, 'a second session is refused').toBe(422)
  expect((await sessions(page)).filter(s => s.status === 'running')).toHaveLength(1)
})

test('finishing early saves only the time that really passed', async ({ page }) => {
  await page.goto('/focus')
  const before = await maxId(page)
  await page.locator('.focus-start').click()
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible()
  await page.waitForTimeout(3000)
  await page.getByRole('button', { name: /Finish & save/ }).click()
  await expect(page.locator('.focus-start')).toBeVisible()
  const done = await newest(page)
  expect((await addedSince(page, before)).map(s => s.status)).toEqual(['completed'])
  expect(done.status).toBe('completed')
  expect(done.elapsed_seconds).toBeLessThan(30)
  expect(done.duration_seconds).toBe(1500)
})

test('when the time really runs out while the page is open, it finishes by itself and saves the full planned time', async ({ page }) => {
  await page.goto('/focus')
  const before = await maxId(page)
  await page.locator('.focus-start').click()
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible()
  moveTimeForward(25 * 60 - 6)
  await page.reload()
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible()
  await expect(page.locator('.focus-start')).toBeVisible({ timeout: 20_000 })
  const done = await newest(page)
  expect(done.status).toBe('completed')
  expect(done.elapsed_seconds).toBe(1500)
  expect((await addedSince(page, before)).map(s => s.status), 'saved once').toEqual(['completed'])
})

test('a session that ended hours ago is not finished or credited by itself: the person decides', async ({ page }) => {
  await page.goto('/focus')
  const before = await maxId(page)
  await page.locator('.focus-start').click()
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible()
  moveTimeForward(3 * 3600)
  await page.reload()
  await expect(page.getByText('This session ended while you were away.')).toBeVisible()
  await page.waitForTimeout(2500)
  expect((await active(page))!.status, 'still running on the server: nothing was decided for the person').toBe('running')
  expect((await addedSince(page, before)).map(s => s.status), 'nothing was saved').toEqual(['running'])
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page.locator('.focus-start')).toBeVisible()
  expect((await addedSince(page, before)).map(s => s.status)).toEqual(['cancelled'])
})

for (const [language, label] of [['en', 'Focus on'], ['ar', 'ركّز على']] as const) {
  test(`the play button on a task opens Focus with the task and its length, and starts only on Start (${language})`, async ({ page, setLanguage }) => {
    await setLanguage(language)
    const made: number[] = []
    try {
      // A task without a length (older data can hold 0) opens at 25 minutes.
      const create = async (title: string, estimated_minutes: number | null) => { const r = await api(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'medium', estimated_minutes: estimated_minutes ?? 30 }); const id = (r.body as { data: { id: number } }).data.id; made.push(id); if (estimated_minutes === null) setEstimate(id, 0); return id }
      const cases: [string, number | null, string, number][] = [[`Focus 60 ${Date.now()}`, 60, '60:00', 3600], [`Focus 90 ${Date.now()}`, 90, '1:30:00', 5400], [`Focus none ${Date.now()}`, null, '25:00', 1500]]
      for (const [title, estimate, shown, secondsPlanned] of cases) {
        const id = await create(title, estimate)
        await page.goto('/tasks')
        await page.getByRole('button', { name: new RegExp(`${label} .*${title}`) }).first().click()
        await expect(page).toHaveURL(new RegExp(`/focus\\?task=${id}$`))
        await expect(page.locator('.focus-plan strong')).toHaveText(title)
        await expect(page.locator('.dial-time')).toHaveText(shown)
        await page.waitForTimeout(1500)
        await expect(page.locator('.dial-time'), 'nothing counts until Start').toHaveText(shown)
        expect(await active(page), 'no session exists before Start').toBeUndefined()

        await page.locator('.focus-start').click()
        await expect(page.getByRole('button', { name: /Pause|إيقاف مؤقت/ })).toBeVisible()
        const running = (await active(page))!
        expect(running.task_id).toBe(id)
        expect(running.duration_seconds).toBe(secondsPlanned)
        await page.waitForTimeout(2200)
        await page.getByRole('button', { name: /Finish & save|إنهاء وحفظ/ }).click()
        await expect(page.locator('.focus-start')).toBeVisible()
        const task = ((await api(page, 'GET', `/api/tasks/${id}`)).body as { data: { status: string; actual_minutes: number } }).data
        expect(task.status, 'time spent does not complete the task').toBe('todo')
        expect(task.actual_minutes, 'only the real time is added').toBeLessThanOrEqual(1)
      }
    } finally { for (const id of made) await api(page, 'DELETE', `/api/tasks/${id}`) }
  })
}

test('an unknown task id is reported and the timer still works', async ({ page, guard }) => {
  guard.allowConsole(/404/)
  await page.goto('/focus?task=99999999')
  await expect(page.getByText('That task was not found. Pick another or start without one.')).toBeVisible()
  await expect(page.locator('.dial-time')).toHaveText('25:00')
})
