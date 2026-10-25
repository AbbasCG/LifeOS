import { test, expect } from './fixtures'

test('a weekly plan draft is set up in the AI Control Center and opens as a pending Copilot proposal', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/settings/ai')
  const toggle = page.getByRole('switch', { name: 'Prepare a weekly plan draft' })
  await expect(toggle).not.toBeChecked()
  try {
    await page.locator('label.switch', { has: toggle }).click()
    await expect(toggle).toBeChecked()
    await page.getByLabel('Day').selectOption({ label: 'Friday' })
    await expect(page.getByText('Saved.').first()).toBeVisible()
    await page.getByLabel('Time').selectOption('16:30')
    await expect(page.getByLabel('Time')).toHaveValue('16:30')
    await expect(page.getByLabel('Day')).toHaveValue('5')

    // Preparing a draft now opens it in Copilot: a proposal waiting for approval, nothing applied.
    await page.getByRole('button', { name: 'Prepare a draft now' }).click()
    await expect(page).toHaveURL(/\/assistant\?c=[0-9a-f-]{36}/)
    const reply = page.locator('.chat-turn.assistant')
    await expect(reply).toHaveCount(1)
    await expect(reply.locator('.notice')).toContainText('Draft prepared at your request, with the week planner and your preferences. Nothing changes until you approve it.')
    const proposal = reply.locator('.proposal-card')
    if (await proposal.count()) await expect(proposal.getByText('Needs your approval')).toBeVisible()

    const history = page.getByRole('button', { name: 'History', exact: true })
    if (await history.isVisible()) await history.click()
    page.once('dialog', d => void d.accept())
    await page.getByRole('button', { name: /^Delete “Draft next week’s plan/ }).click()
    await expect(page.getByText('How can I help today?')).toBeVisible()
  } finally {
    await page.evaluate(async () => {
      const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
      await fetch('/api/copilot/weekly-draft', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: JSON.stringify({ enabled: false, weekday: 0, time: '18:00', template_id: null }) })
    })
  }
})
