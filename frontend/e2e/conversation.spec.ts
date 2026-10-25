import { test, expect, noHorizontalOverflow } from './fixtures'
import type { Page } from '@playwright/test'

/** Delete a conversation from the history (a drawer on small screens), accepting the confirmation. */
async function deleteConversation(page: Page, name: RegExp, history = 'History') {
  const toggle = page.getByRole('button', { name: history, exact: true })
  if (await toggle.isVisible()) await toggle.click()
  page.once('dialog', d => void d.accept())
  await page.getByRole('button', { name }).click()
}

// One fixed window per test file run: demo events are seeded relative to "now", so a sliding window can gain one mid-test.
const from = new Date(Date.now() - 3600000).toISOString(), to = new Date(Date.now() + 9 * 86400000).toISOString()
const events = (page: Page) => page.evaluate(async ([from, to]) => {
  return (await (await fetch(`/api/calendar?from=${from}&to=${to}`, { credentials: 'include', headers: { Accept: 'application/json' } })).json()).data?.length ?? -1
}, [from, to])

test('a Copilot conversation plans focus blocks, follows up, refuses chat approval and keeps history', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/assistant')
  const start = await events(page)
  const composer = page.getByRole('textbox', { name: 'Message' })

  await composer.fill('Find two focus blocks this week')
  await composer.press('Enter')
  const first = page.locator('.chat-turn.assistant').nth(0)
  await expect(first.locator('.plan-card')).toBeVisible()
  await expect(first.getByText('Rule-based · Local assistant')).toBeVisible()
  await expect(first.getByText('Used on this server:')).toBeVisible()
  await expect(first.locator('.proposal-card').getByText('Needs your approval')).toBeVisible()
  await expect(page).toHaveURL(/[?&]c=[0-9a-f-]{36}/)

  // A follow-up replaces the plan; the earlier proposal is withdrawn.
  await composer.fill('make them 90 minutes')
  await composer.press('Enter')
  const second = page.locator('.chat-turn.assistant').nth(1)
  await expect(second.locator('.plan-impact')).toContainText('3h')
  await expect(first.locator('.proposal-card').getByText('Dismissed')).toBeVisible()

  // Agreeing in chat applies nothing.
  await composer.fill('yes, apply it')
  await composer.press('Enter')
  await expect(page.locator('.chat-turn.assistant').nth(2)).toContainText('I don’t apply changes from chat')
  expect(await events(page), 'nothing changes from chat').toBe(start)

  // Partial approval through the proposal button.
  const card = second.locator('.proposal-card')
  await card.locator('input[type=checkbox]').first().uncheck()
  await card.locator('.toolbar button.primary').click()
  await expect(card.getByText('Applied')).toBeVisible()
  expect(await events(page)).toBe(start + 1)
  await card.getByRole('button', { name: /Undo these changes/ }).click()
  await expect(card.getByText('Undone')).toBeVisible()
  expect(await events(page)).toBe(start)

  // History survives a reload and can be deleted.
  await page.reload()
  await expect(page.locator('.chat-turn')).toHaveCount(6)
  await expect(page.locator('.chat-turn.assistant').nth(1).locator('.proposal-card').getByText('Undone')).toBeVisible()
  await deleteConversation(page, /^Delete “Find two focus blocks this week”/)
  await expect(page.getByText('How can I help today?')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete “Find two focus blocks this week”' })).toHaveCount(0)
})

test('clarifying questions and plan alternatives', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/assistant')
  const composer = page.getByRole('textbox', { name: 'Message' })
  await composer.fill('Prioritize my week')
  await composer.press('Enter')
  const question = page.locator('.chat-turn.assistant').nth(0)
  await expect(question.getByText('What should come first?')).toBeVisible()
  await question.getByRole('button', { name: 'Your projects' }).click()
  const plan = page.locator('.chat-turn.assistant').nth(1).locator('.plan-card')
  await expect(plan.getByRole('button', { name: 'Everything, by priority' })).toHaveAttribute('aria-pressed', 'true')
  await plan.getByRole('button', { name: 'Essentials only' }).click()
  await expect(page.locator('.chat-turn.assistant').nth(2).locator('.plan-card').getByRole('button', { name: 'Essentials only' })).toHaveAttribute('aria-pressed', 'true')
  await deleteConversation(page, /^Delete “Prioritize my week”/)
  await expect(page.getByText('How can I help today?')).toBeVisible()
})

test('Arabic conversation workspace is right-to-left, with a history drawer on mobile', async ({ page, setLanguage, isMobile }) => {
  await setLanguage('ar')
  await page.goto('/assistant')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  const composer = page.getByRole('textbox', { name: 'الرسالة' })
  await composer.fill('اعثر على فترتي تركيز هذا الأسبوع')
  await composer.press('Enter')
  const reply = page.locator('.chat-turn.assistant').last()
  await expect(reply.locator('.plan-card')).toBeVisible()
  await expect(reply.getByText('قواعد · مساعد محلي')).toBeVisible()
  await noHorizontalOverflow(page)
  if (isMobile) {
    await expect(page.locator('.copilot-sidebar')).not.toBeInViewport()
    await page.getByRole('button', { name: 'السجل', exact: true }).click()
    await expect(page.locator('.copilot-sidebar')).toBeInViewport()
    await page.locator('.copilot-sidebar').getByRole('button', { name: 'إغلاق السجل' }).click()
    await expect(page.locator('.copilot-sidebar')).not.toBeInViewport()
  }
  await deleteConversation(page, /^حذف «اعثر على فترتي تركيز/, 'السجل')
  await setLanguage('en')
})
