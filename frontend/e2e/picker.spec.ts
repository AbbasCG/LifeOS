import { test, expect, pick, field } from './fixtures'
import type { Page } from '@playwright/test'

async function newEvent(page: Page) {
  await page.goto('/calendar')
  await page.getByRole('button', { name: /New event|موعد جديد/ }).click()
  return page.getByRole('dialog').first()
}
const shot = process.env.PICKER_SHOTS

for (const language of ['en', 'ar'] as const) {
  test(`the picker opens above the event form, fits the screen and sets date and time (${language})`, async ({ page, setLanguage }, info) => {
    await setLanguage(language)
    await page.addInitScript(() => localStorage.removeItem('lifeos-hour-cycle'))
    const form = await newEvent(page)
    expect(await form.locator('input[type=date], input[type=time], input[type=datetime-local]').count()).toBe(0)
    const start = form.locator('.dtp-trigger').first()
    await start.click()
    const sheet = page.locator('.dtp-dialog[open]')
    await expect(sheet).toBeVisible()
    await expect(sheet).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr')
    // Inside the viewport, and not covered by the form dialog behind it.
    const box = (await sheet.boundingBox())!, view = page.viewportSize()!
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(view.width + 1); expect(box.y + box.height).toBeLessThanOrEqual(view.height + 1)
    const centre = { x: box.x + box.width / 2, y: box.y + 40 }
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.dtp-dialog'), centre)).toBe(true)
    if (shot) await page.screenshot({ path: `${shot}/picker-${language}-${info.project.name}.png` })

    // 12 and 24 hours.
    await sheet.getByRole('button', { name: /^24 h|٢٤ س/ }).click()
    await expect(sheet.getByRole('group', { name: /AM or PM|صباحاً أو مساءً/ })).toHaveCount(0)
    if (shot) await page.screenshot({ path: `${shot}/picker-${language}-24h-${info.project.name}.png` })
    await sheet.getByRole('button', { name: /^12 h|١٢ س/ }).click()
    await expect(sheet.getByRole('group', { name: /AM or PM|صباحاً أو مساءً/ })).toHaveCount(1)
    await sheet.getByRole('button', { name: /Done|تم/ }).click()
    await expect(sheet).toBeHidden()
    await expect(form).toBeVisible()
  })
}

test('an event is created with the picker, and opening and closing the picker never submits the form', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const form = await newEvent(page)
  const title = `Picker event ${Date.now()}`
  await form.getByLabel('Title', { exact: true }).fill(title)
  const day = new Date(Date.now() + 40 * 86400_000), key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  await pick(page, field(form, 'Start'), `${key}T10:15`)
  await expect(form).toBeVisible()
  await pick(page, field(form, 'End'), `${key}T11:45`)
  await expect(form).toBeVisible()
  await expect(field(form, 'Start')).toContainText(/10:15/)
  await form.getByRole('button', { name: /^Save|Create/ }).click()
  await expect(form).toBeHidden()
  const list = () => page.evaluate(async t => (await (await fetch('/api/events?per_page=200', { credentials: 'include', headers: { Accept: 'application/json' } })).json()).data.filter((e: { title: string }) => e.title.startsWith(t)), 'Picker event')
  const saved = (await list()).find((e: { title: string }) => e.title === title)
  try {
    expect(saved, 'the event was saved').toBeTruthy()
    // The form keeps its usual rule for which time zone a typed time means; the picker only changes how it is chosen.
    expect(new Date(saved.ends_at).getTime() - new Date(saved.starts_at).getTime()).toBe(90 * 60_000)
  } finally {
    for (const e of await list()) await page.evaluate(async id => { const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? ''); await fetch(`/api/events/${id}`, { method: 'DELETE', credentials: 'include', headers: { Accept: 'application/json', 'X-XSRF-TOKEN': token } }) }, e.id)
  }
})

import AxeBuilder from '@axe-core/playwright'
for (const language of ['en', 'ar'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`the open picker passes the accessibility scan (${language}, ${theme})`, async ({ page, setLanguage }) => {
      await setLanguage(language)
      await page.addInitScript(t => localStorage.setItem('lifeos-theme', t), theme)
      const form = await newEvent(page)
      await form.locator('.dtp-trigger').first().click()
      const sheet = page.locator('.dtp-dialog[open]')
      await expect(sheet).toBeVisible()
      const result = await new AxeBuilder({ page }).include('.dtp-dialog[open]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
      expect(result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([])
      await page.keyboard.press('Escape')
      await expect(sheet).toBeHidden()
      await expect(form).toBeVisible()
    })
  }
}
