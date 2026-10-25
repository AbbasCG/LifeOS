import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return r.status === 204 ? null : r.json()
  }, [method, path, body] as const)
}

test('a goal is reviewed for this month in Copilot, with a next step that waits for approval', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/goals')
  const due = new Date(Date.now() + 120 * 86400 * 1000).toISOString()
  const goal = (await call(page, 'POST', '/api/goals', { title: 'E2E learn Spanish', target: 100, progress: 20, due_at: due, milestones: [{ title: 'Finish A1 course', completed: false }] })).data
  try {
    await page.reload()
    await page.getByRole('button', { name: 'Review “E2E learn Spanish” this month' }).click()
    await expect(page).toHaveURL(/\/assistant\?c=[0-9a-f-]{36}/)
    const reply = page.locator('.chat-turn.assistant')
    await expect(reply).toHaveCount(1)
    await expect(reply).toContainText('Review of “E2E learn Spanish”')
    await expect(reply).toContainText('Progress: 20%')
    await expect(reply).toContainText('Proposed next step: dated tasks for this goal.')
    const proposal = reply.locator('.proposal-card')
    await expect(proposal.getByText('Needs your approval')).toBeVisible()
    await expect(proposal).toContainText('Finish A1 course')

    const history = page.getByRole('button', { name: 'History', exact: true })
    if (await history.isVisible()) await history.click()
    page.once('dialog', d => void d.accept())
    await page.getByRole('button', { name: /^Delete “Review my goal “E2E learn Spanish”/ }).click()
    await expect(page.getByText('How can I help today?')).toBeVisible()
  } finally {
    await call(page, 'DELETE', `/api/goals/${goal.id}`)
  }
})
