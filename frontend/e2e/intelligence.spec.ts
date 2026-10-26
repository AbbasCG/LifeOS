import { test, expect } from './fixtures'

test('morning intelligence explains the day, and suggestions only become proposals', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/')
  // Today leads with the next action; the full morning briefing is one tap away.
  await page.getByText('More for today').click()
  const briefing = page.locator('.intel-briefing')
  await expect(briefing.getByRole('heading', { name: 'Morning intelligence' })).toBeVisible()
  await expect(briefing.locator('.intel-list li').first()).toBeVisible()
  await expect(briefing.locator('.intel-list .chip[class*="conf-"]').first()).toBeVisible()
  for (const tab of ['Today', 'Focus', 'Watch-outs', 'Priorities']) {
    await briefing.getByRole('tab', { name: new RegExp(tab) }).click()
    await expect(briefing.getByRole('tab', { name: new RegExp(tab) })).toHaveAttribute('aria-selected', 'true')
  }

  const cards = briefing.locator('.rec-card')
  if (await cards.count()) {
    const card = cards.first()
    await card.getByRole('button', { name: 'Why?' }).click()
    await expect(card.locator('.rec-why')).toBeVisible()
    await card.getByRole('button', { name: 'Useful', exact: true }).click()
    await expect(card.getByRole('button', { name: 'Useful', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await card.getByRole('button', { name: 'Dismiss or snooze' }).click()
    await card.getByRole('menuitem', { name: 'Dismiss' }).click()
    await expect(page.getByText('Dismissed. It won’t come back.')).toBeVisible()
  }
})

test('weekly intelligence separates measured facts from interpretations', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/review')
  // On Mondays the demo week under review is already completed, so the page opens on "Next week".
  await page.getByRole('button', { name: /Look back/ }).click()
  const weekly = page.locator('.weekly-insights')
  await expect(weekly.getByRole('heading', { name: 'Weekly intelligence' })).toBeVisible()
  await expect(weekly.getByText('Measured')).toBeVisible()
  await expect(weekly.getByText('Interpretations · rule-based')).toBeVisible()
  await weekly.getByRole('button', { name: /Summarise my week/ }).click()
  // No external AI in the test environment: the summary is rule-based and says so.
  await expect(weekly.getByText('Rule-based summary', { exact: true })).toBeVisible()
})

test('re-planning after an interruption, and the AI Control Center in Arabic', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/today/plan')
  await expect(page.getByRole('radio', { name: /Deadlines first/ })).toBeVisible()
  await page.getByRole('button', { name: /Something came up/ }).click()
  await page.getByLabel('Busy until').fill('16:00')
  await expect(page.locator('.why-list')).toContainText('Re-planned from 16:00')

  await setLanguage('ar')
  try {
    await page.goto('/settings/ai')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await expect(page.getByRole('heading', { name: 'مركز التحكم بالذكاء الاصطناعي' })).toBeVisible()
    const habits = page.getByRole('switch', { name: 'العادات', exact: true })
    // The checkbox sits under the visual switch; click the switch the way a person would.
    const toggle = page.locator('label.switch', { has: habits })
    const was = await habits.isChecked()
    await toggle.click()
    await expect(habits).toBeChecked({ checked: !was })
    await expect(page.getByText('تم الحفظ.').first()).toBeVisible()
    await toggle.click()
    await expect(habits).toBeChecked({ checked: was })
    await page.getByRole('tab', { name: 'السجل' }).click()
    await expect(page.locator('.ai-activity li').first()).toBeVisible()
  } finally {
    await setLanguage('en')
  }
})
