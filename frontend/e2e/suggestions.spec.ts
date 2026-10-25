import { test, expect } from './fixtures'

test('a suggestion opens as a Copilot conversation, and nothing changes before approval', async ({ page, setLanguage }) => {
  await setLanguage('en')
  // A high-priority task due tomorrow with no time booked for it guarantees a deadline suggestion.
  const task = await page.evaluate(async () => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const due = new Date(Date.now() + 30 * 3600 * 1000).toISOString()
    const r = await fetch('/api/tasks', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: JSON.stringify({ title: 'E2E board deck', priority: 'urgent', estimated_minutes: 120, due_at: due, status: 'todo' }) })
    return (await r.json()).data?.id as number
  })
  expect(task).toBeTruthy()
  await page.goto('/')
  // At most six suggestions show at a time, so use whichever comes first (there is always at least this one).
  const card = page.locator('.rec-card').first()
  await expect(card).toBeVisible()
  const title = (await card.locator('.rec-text strong').textContent())?.trim()
  await card.getByRole('button', { name: 'Ask Copilot' }).click()
  await expect(page).toHaveURL(/\/assistant\?c=[0-9a-f-]{36}/)
  await expect(page.locator('.chat-turn.user')).toHaveCount(1)
  await expect(page.locator('.chat-turn.assistant')).toHaveCount(1)
  await expect(page.locator('.chat-turn.assistant').getByText('Rule-based · Local assistant')).toBeVisible()
  const proposal = page.locator('.chat-turn.assistant .proposal-card')
  if (await proposal.count()) await expect(proposal.getByText('Needs your approval')).toBeVisible()

  // The suggestion's conversation can be deleted like any other.
  const toggle = page.getByRole('button', { name: 'History', exact: true })
  if (await toggle.isVisible()) await toggle.click()
  const name = await page.locator('.chat-title').textContent()
  page.once('dialog', d => void d.accept())
  await page.getByRole('button', { name: `Delete “${name}”` }).click()
  await expect(page.getByText('How can I help today?')).toBeVisible()
  expect(title).toBeTruthy()
  await page.evaluate(async id => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    await fetch(`/api/tasks/${id}`, { method: 'DELETE', credentials: 'include', headers: { Accept: 'application/json', 'X-XSRF-TOKEN': token } })
  }, task)
})
