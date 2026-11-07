import AxeBuilder from '@axe-core/playwright'
import { test, expect } from './fixtures'

/**
 * Regression: the Today greeting ("Good evening, Noor") shares a row with the date on a phone when it is short, and then sits on the
 * decorative aurora glow, where its muted colour measured 4.15:1 (needs 4.5). Which greeting shows depends on the time of day, so the
 * check once passed in the afternoon and failed in the evening. This test forces each period instead of waiting for the clock.
 */
for (const language of ['en', 'ar'] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    for (const period of ['morning', 'afternoon', 'evening'] as const) {
      test(`the Today greeting keeps its contrast in the ${period} (${language}, ${scheme})`, async ({ page, setLanguage, isMobile }) => {
        test.skip(!isMobile, 'the greeting only meets the glow on a phone-width screen')
        await setLanguage(language)
        await page.emulateMedia({ colorScheme: scheme })
        await page.route('**/api/briefing', async route => {
          const response = await route.fetch()
          await route.fulfill({ response, json: { ...(await response.json()), period } })
        })
        await page.goto('/')
        await expect(page.locator('.today-head > .muted')).toBeVisible()
        await page.waitForLoadState('networkidle')
        await page.waitForTimeout(500)
        const { violations } = await new AxeBuilder({ page }).include('.today-head').withTags(['wcag2aa']).analyze()
        expect(violations.map(v => `${v.id}: ${v.nodes.map(n => (n.any[0]?.data as { contrastRatio?: number } | undefined)?.contrastRatio).join(', ')}`)).toEqual([])
      })
    }
  }
}
