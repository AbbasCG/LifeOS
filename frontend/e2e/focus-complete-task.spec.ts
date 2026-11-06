import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * Finishing a focus session on a task saves the real time, then asks "Complete task" / "Keep it open". Nothing is completed before the
 * person answers, never by the timer or by cancelling, and answering updates Tasks and Today without a page reload.
 */
const api = (page: Page, method: string, path: string, body?: unknown) => page.evaluate(async ([m, p, b]) => {
  const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
  const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
}, [method, path, body] as const)

type S = { id: number; status: string; elapsed_seconds: number; task_id: number | null }
const sessions = async (page: Page) => ((await api(page, 'GET', '/api/focus-sessions')).body as { data: S[] }).data
const taskState = async (page: Page, id: number) => ((await api(page, 'GET', `/api/tasks/${id}`)).body as { data: { status: string; actual_minutes: number; completed_at: string | null } }).data
const overview = async (page: Page) => (await api(page, 'GET', '/api/overview')).body as { completed_tasks: number }

async function clean(page: Page) {
  for (const s of await sessions(page)) if (s.status === 'running' || s.status === 'paused') await api(page, 'PATCH', `/api/focus-sessions/${s.id}`, { action: 'cancel' })
}

test.beforeEach(async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.evaluate(() => { localStorage.setItem('lifeos-language', 'en'); sessionStorage.clear() })
  await clean(page)
})
test.afterEach(async ({ page }) => { await clean(page).catch(() => undefined) })

async function startOnTask(page: Page, title: string) {
  const id = ((await api(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'medium', estimated_minutes: 45 })).body as { data: { id: number } }).data.id
  await page.goto('/tasks')
  await page.getByRole('button', { name: new RegExp(`Focus on .*${title}`) }).first().click()
  await expect(page).toHaveURL(new RegExp(`/focus\\?task=${id}$`))
  await page.locator('.focus-start').click()
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible()
  await page.waitForTimeout(2500)
  return id
}

test('finish, then "Complete task": the time is saved first, the task completes once, and Tasks, Today and the statistics update without a reload', async ({ page }) => {
  const title = `Finish and complete ${Date.now()}`
  const id = await startOnTask(page, title)
  const completedBefore = (await overview(page)).completed_tasks

  await page.getByRole('button', { name: /Finish & save/ }).click()
  await expect(page.getByText('Is the task done?')).toBeVisible()
  expect(await taskState(page, id), 'asking does not change the task').toMatchObject({ status: 'todo' })
  const session = (await sessions(page)).find(s => s.task_id === id)!
  expect(session.status).toBe('completed')
  expect(session.elapsed_seconds, 'the real time is saved').toBeLessThan(30)

  // Keep the Tasks and Today pages alive in other tabs of the same app to prove they refresh by themselves.
  const tasksTab = await page.context().newPage()
  await tasksTab.goto('/tasks')
  await expect(tasksTab.getByText(title).first()).toBeVisible()

  const completeButton = page.getByRole('button', { name: 'Complete task' })
  await completeButton.dblclick()
  await expect(page.getByText('Is the task done?')).toBeHidden()
  await expect(page.getByText(`Task completed: “${title}”.`)).toBeVisible()
  const done = await taskState(page, id)
  expect(done.status).toBe('completed')
  expect(done.completed_at).not.toBeNull()
  expect((await overview(page)).completed_tasks, 'the statistics count it').toBe(completedBefore + 1)

  // In the app, going to Tasks shows it among the completed, and no longer among the open ones, with no manual reload.
  const phone = page.viewportSize()!.width <= 700
  await (phone ? page.locator('.mobile-nav').getByRole('link', { name: 'Tasks', exact: true }) : page.getByRole('link', { name: 'Tasks', exact: true }).first()).click()
  await expect(page).toHaveURL(/\/tasks/)
  const open = ((await api(page, 'GET', '/api/tasks?due=open&per_page=100')).body as { data: { id: number }[] }).data
  expect(open.map(t => t.id)).not.toContain(id)
  await tasksTab.close()
})

test('finish, then "Keep it open": the time stays saved and the task stays open', async ({ page }) => {
  const title = `Finish keep open ${Date.now()}`
  const id = await startOnTask(page, title)
  await page.getByRole('button', { name: /Finish & save/ }).click()
  await page.getByRole('button', { name: 'Keep it open' }).click()
  await expect(page.getByText('Is the task done?')).toBeHidden()
  expect(await taskState(page, id)).toMatchObject({ status: 'todo' })
  expect((await sessions(page)).find(s => s.task_id === id)!.status).toBe('completed')
  await page.reload()
  await expect(page.getByText('Is the task done?'), 'answered once, not asked again').toHaveCount(0)
  await api(page, 'DELETE', `/api/tasks/${id}`)
})

test('the question survives a refresh until answered; discarding a session asks nothing and the task stays open', async ({ page }) => {
  const title = `Finish refresh ${Date.now()}`
  const id = await startOnTask(page, title)
  await page.getByRole('button', { name: /Finish & save/ }).click()
  await expect(page.getByText('Is the task done?')).toBeVisible()
  await page.reload()
  await expect(page.getByText('Is the task done?')).toBeVisible()
  expect(await taskState(page, id)).toMatchObject({ status: 'todo' })

  await page.getByRole('button', { name: 'Keep it open' }).click()
  await page.locator('.focus-start').click()
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible()
  await page.getByRole('button', { name: 'Discard session' }).click()
  await expect(page.locator('.focus-start')).toBeVisible()
  await expect(page.getByText('Is the task done?')).toHaveCount(0)
  expect(await taskState(page, id)).toMatchObject({ status: 'todo' })
  await api(page, 'DELETE', `/api/tasks/${id}`)
})

test('a session with no task asks nothing, and the endpoint refuses to complete anything for it', async ({ page, guard }) => {
  guard.allowConsole(/422/)
  await page.goto('/focus')
  await page.locator('.focus-start').click()
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible()
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: /Finish & save/ }).click()
  await expect(page.locator('.focus-start')).toBeVisible()
  await expect(page.getByText('Is the task done?')).toHaveCount(0)
  const last = (await sessions(page)).sort((a, b) => b.id - a.id)[0]
  expect(last.task_id).toBeNull()
  expect((await api(page, 'POST', `/api/focus-sessions/${last.id}/complete-task`)).status).toBe(422)
})

test('in Arabic the question is asked in Arabic with the primary action first', async ({ page, setLanguage }) => {
  await setLanguage('ar')
  await page.evaluate(() => { localStorage.setItem('lifeos-language', 'ar'); sessionStorage.clear() })
  const title = `إنهاء ${Date.now()}`
  const id = ((await api(page, 'POST', '/api/tasks', { title, status: 'todo', priority: 'medium', estimated_minutes: 45 })).body as { data: { id: number } }).data.id
  await page.goto(`/focus?task=${id}`)
  await page.locator('.focus-start').click()
  await expect(page.getByRole('button', { name: /إيقاف مؤقت/ })).toBeVisible()
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: /إنهاء وحفظ/ }).click()
  await expect(page.getByText('هل انتهت المهمة؟')).toBeVisible()
  const buttons = page.locator('.focus-wrapup button')
  await expect(buttons.first()).toContainText('إكمال المهمة')
  await expect(buttons.nth(1)).toContainText('إبقاؤها مفتوحة')
  await buttons.first().click()
  await expect(page.getByText('هل انتهت المهمة؟')).toBeHidden()
  expect((await taskState(page, id)).status).toBe('completed')
  await api(page, 'DELETE', `/api/tasks/${id}`)
})
