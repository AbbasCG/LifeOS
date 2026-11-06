import { test, expect } from './fixtures'

/**
 * The sidebar shows no scrollbar but still scrolls: wheel, touch/programmatic scrolling and the keyboard (Tab to the last item) all
 * reach every item, on a short screen, in English and Arabic, light and dark, on the desktop sidebar and the phone drawer.
 */
for (const language of ['en', 'ar'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`the sidebar has no visible scrollbar and still reaches every item (${language}, ${theme})`, async ({ page, setLanguage }, info) => {
      await setLanguage(language)
      await page.addInitScript(([t, l]) => { localStorage.setItem('lifeos-theme', t); localStorage.setItem('lifeos-language', l) }, [theme, language])
      const phone = info.project.name === 'mobile'
      if (!phone) await page.setViewportSize({ width: 1280, height: 420 })
      await page.goto('/')
      if (phone) await page.getByRole('button', { name: /Toggle menu|تبديل القائمة/ }).first().click()
      const sidebar = page.locator('aside.sidebar')
      await expect(sidebar).toBeVisible()

      const style = await sidebar.evaluate(el => ({ overflowY: getComputedStyle(el).overflowY, scrollbarWidth: getComputedStyle(el).scrollbarWidth, scrollable: el.scrollHeight > el.clientHeight, scrollbarSpace: (el as HTMLElement).offsetWidth - el.clientWidth - (parseFloat(getComputedStyle(el).borderLeftWidth) + parseFloat(getComputedStyle(el).borderRightWidth)) }))
      expect(style.overflowY, 'still scrollable, not clipped').toMatch(/auto|scroll/)
      expect(style.scrollbarWidth).toBe('none')
      expect(style.scrollable, 'the content is taller than the sidebar on this screen').toBe(true)
      expect(style.scrollbarSpace, 'no space is taken by a scrollbar').toBeLessThanOrEqual(1)

      // Wheel (or touch) scrolling moves it, and the last item can be reached.
      const last = sidebar.locator('nav a').last()
      await sidebar.hover().catch(() => undefined)
      if (!phone) await page.mouse.wheel(0, 2000); else await sidebar.evaluate(el => el.scrollBy(0, 2000))
      await expect.poll(() => sidebar.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
      await expect(last).toBeInViewport()

      // Keyboard: tabbing through the links brings the focused one into view.
      await sidebar.evaluate(el => { el.scrollTop = 0 })
      const settings = sidebar.getByRole('link', { name: /^Settings$|^الإعدادات$/ })
      await settings.focus()
      await expect(settings).toBeInViewport()
      await page.keyboard.press('Tab')
      await expect.poll(() => sidebar.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    })
  }
}
