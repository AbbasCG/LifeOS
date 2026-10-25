import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/** Open the conversation history (a drawer on small screens). */
async function history(page: Page) {
  const toggle = page.getByRole('button', { name: 'History', exact: true })
  if (await toggle.isVisible()) await toggle.click()
}

test('save a plan as a template, plan a week from it, search and export conversations', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/assistant')
  const composer = page.getByRole('textbox', { name: 'Message' })
  await composer.fill('Find two focus blocks this week')
  await composer.press('Enter')
  const card = page.locator('.chat-turn.assistant').last().locator('.proposal-card')
  await expect(card.getByText('Needs your approval')).toBeVisible()

  // Save as a template.
  await card.getByRole('button', { name: 'Save as template' }).click()
  await card.getByLabel('Template name').fill('E2E focus week')
  await card.getByRole('button', { name: 'Save template' }).click()
  await expect(page.getByText('Saved as a week template. Use it from the Copilot sidebar.')).toBeVisible()

  // Export the conversation: a Markdown download with the request and the proposal.
  const href = await page.getByRole('link', { name: 'Export this conversation as Markdown' }).getAttribute('href')
  const download = await page.request.get(href!)
  expect(download.status()).toBe(200)
  expect(download.headers()['content-disposition']).toContain('attachment; filename="lifeos-conversation-')
  const markdown = await download.text()
  expect(markdown).toContain('# Find two focus blocks this week')
  expect(markdown).toContain('**Proposal** (pending)')

  // Plan next week from the template: a new pending proposal, nothing written yet.
  await history(page)
  const sidebar = page.locator('.copilot-sidebar')
  await expect(sidebar.getByText('E2E focus week')).toBeVisible()
  await sidebar.getByRole('button', { name: 'Plan next week from “E2E focus week”' }).click()
  const reply = page.locator('.chat-turn.assistant').last()
  await expect(reply.locator('.plan-card')).toContainText('Template “E2E focus week”')
  await expect(reply.locator('.proposal-card').getByText('Week from your template')).toBeVisible()
  await expect(reply.locator('.proposal-card').getByText('Needs your approval')).toBeVisible()
  await expect(reply.locator('.proposal-card').getByRole('button', { name: 'Save as template' })).toHaveCount(0)

  // Search finds the conversation by its text.
  await history(page)
  await sidebar.getByRole('searchbox', { name: 'Search conversations' }).fill('E2E focus week')
  await expect(sidebar.getByRole('status')).toContainText('conversation(s) found')
  await expect(sidebar.locator('.search-match').first()).toContainText('E2E focus week')
  await sidebar.getByRole('searchbox', { name: 'Search conversations' }).fill('')

  // Clean up: the template and the conversation.
  page.once('dialog', d => void d.accept())
  await sidebar.getByRole('button', { name: 'Delete template “E2E focus week”' }).click()
  await expect(sidebar.getByText('E2E focus week')).toHaveCount(0)
  page.once('dialog', d => void d.accept())
  await sidebar.getByRole('button', { name: /^Delete “Find two focus blocks this week”/ }).click()
  await expect(page.getByText('How can I help today?')).toBeVisible()
})
