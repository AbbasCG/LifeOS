import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * Automated accessibility checks (axe, WCAG 2.1 A and AA rules) on every main page and the common sheets, in English
 * and Arabic, light and dark. Axe finds what can be found automatically (names, roles, contrast, focusable scroll
 * areas); the keyboard walk below covers what it cannot.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']
const PAGES = ['/', '/tasks', '/calendar', '/today/plan', '/planning', '/focus', '/goals', '/habits', '/projects', '/categories', '/timeline', '/review', '/analytics', '/assistant',
  '/settings', '/settings/security', '/settings/integrations', '/settings/ai', '/settings/assistant', '/settings/notifications', '/settings/automations', '/settings/wellbeing']

const describe = (path: string, violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']) =>
  violations.map(v => `${path} ${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => {
    const c = n.any[0]?.data as { fgColor?: string; bgColor?: string; contrastRatio?: number } | undefined
    return n.target.join(' ') + (v.id === 'color-contrast' && c ? ` [${c.fgColor} on ${c.bgColor} = ${c.contrastRatio}]` : '')
  }).join(' | ')}`)

/** Waits for finite animations and transitions to end; looping ones (a pulsing dot) are ignored. */
async function settle(page: Page) {
  await page.waitForTimeout(300)
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), undefined, { timeout: 5000 }).catch(() => {})
}

async function scan(page: Page, path: string) {
  await page.goto(path)
  await expect(page.locator('main')).toBeVisible()
  // Let lazy pieces load and entrance animations finish, so contrast is measured on the final colours.
  await page.waitForLoadState('networkidle')
  await settle(page)
  return describe(path, (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations)
}

async function scanSheet(page: Page, name: string) {
  await expect(page.locator('dialog[open]')).toBeVisible()
  await settle(page)
  return describe(name, (await new AxeBuilder({ page }).include('dialog[open]').withTags(TAGS).analyze()).violations)
}

for (const language of ['en', 'ar'] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`no axe violations on the main pages and sheets: ${language}, ${scheme}`, async ({ page, setLanguage }) => {
      test.setTimeout(240_000)
      await setLanguage(language)
      await page.emulateMedia({ colorScheme: scheme })
      const found: string[] = []
      for (const path of PAGES) found.push(...await scan(page, path))
      await expect(page.locator('html')).toHaveAttribute('lang', language)
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)

      await page.goto('/')
      await page.getByRole('button', { name: language === 'en' ? 'Quick add' : 'إضافة سريعة' }).first().click()
      found.push(...await scanSheet(page, 'quick add'))
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: language === 'en' ? 'Customize Today' : 'تخصيص «اليوم»' }).click()
      found.push(...await scanSheet(page, 'customize today'))
      expect(found).toEqual([])
    })
  }
}

test('the sign-in page has no axe violations in either language', async ({ browser }) => {
  for (const language of ['en', 'ar']) {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    await context.addInitScript(l => localStorage.setItem('lifeos-language', l), language)
    const page = await context.newPage()
    await page.goto('/login')
    await expect(page.locator('input[type=password]')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', language)
    expect(describe(`/login ${language}`, (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations)).toEqual([])
    await context.close()
  }
})

test.describe('keyboard only', () => {
  test.skip(({ isMobile }) => isMobile, 'a hardware keyboard walk; phones are covered by the axe checks above')

  /** Presses Tab until the focused element matches, like a keyboard user would; fails if it is never reached. */
  async function tabTo(page: Page, matches: string, limit = 60) {
    for (let i = 0; i < limit; i++) {
      await page.keyboard.press('Tab')
      if (await page.evaluate(`(el => ${matches})(document.activeElement)`)) return
    }
    throw new Error('not reachable with Tab')
  }

  test('skip link, quick add, search and navigation work without a mouse, and focus is always visible', async ({ page, setLanguage }) => {
    await setLanguage('en')
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    // The first Tab lands on the skip link, which becomes visible and moves focus to the content.
    await page.keyboard.press('Tab')
    const skip = page.getByRole('link', { name: /Skip to content/ })
    await expect(skip).toBeFocused()
    await expect(skip).toBeInViewport()
    await page.keyboard.press('Enter')
    await expect(page.locator('main')).toBeFocused()

    // Quick add opens from the keyboard, takes focus, closes on Escape and hands focus back.
    await page.locator('body').focus()
    await tabTo(page, "el.getAttribute('aria-label') === 'Quick add'")
    const opener = page.locator(':focus')
    expect(await opener.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none')
    await page.keyboard.press('Enter')
    const sheet = page.getByRole('dialog', { name: 'Quick add' })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole('textbox', { name: 'Task' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(page.getByRole('banner').getByRole('button', { name: 'Quick add' })).toBeFocused()

    // Search opens with Ctrl K and closes with Escape.
    await page.keyboard.press('Control+k')
    await expect(page.locator('dialog[open]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('dialog[open]')).toHaveCount(0)

    // The sidebar is reachable and links follow on Enter.
    await tabTo(page, "el.tagName === 'A' && el.getAttribute('href') === '/tasks'")
    expect(await page.locator(':focus').evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/tasks$/)

    // Filter chips are one radio group: Space picks one.
    await tabTo(page, "el.getAttribute('role') === 'radio' && el.textContent === 'Late'")
    await page.keyboard.press('Space')
    await expect(page.getByRole('radio', { name: 'Late' })).toHaveAttribute('aria-checked', 'true')
  })
})

test('motion is reduced when the system asks for it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.locator('main')).toBeVisible()
  const duration = await page.evaluate(() => { const el = document.querySelector('.panel, .today-section'); return el ? getComputedStyle(el).transitionDuration : '' })
  expect(duration.split(',').every(d => parseFloat(d) <= 0.0001)).toBe(true)
})
