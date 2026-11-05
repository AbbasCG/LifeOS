import { test, expect } from './fixtures'

/** Arabic text is set in Thmanyah Sans (headings in Thmanyah Serif Display); English keeps Inter. The licensed files are not in Git, so loading is only checked where they are installed. */
test('Arabic uses Thmanyah, English keeps Inter, and an installed font file really loads', async ({ page, setLanguage }) => {
  await setLanguage('ar')
  await page.goto('/')
  await expect(page.locator('.now-card')).toBeVisible()
  const families = async () => page.evaluate(() => ({ body: getComputedStyle(document.body).fontFamily, button: getComputedStyle(document.querySelector('button')!).fontFamily, h1: getComputedStyle(document.querySelector('h1')!).fontFamily, dir: document.documentElement.dir }))
  const ar = await families()
  expect(ar.dir).toBe('rtl')
  expect(ar.body.startsWith('"Thmanyah Sans"')).toBe(true)
  expect(ar.button.startsWith('"Thmanyah Sans"')).toBe(true)
  expect(ar.h1.startsWith('"Thmanyah Serif Display"')).toBe(true)

  const installed = await page.evaluate(async () => { const r = await fetch('/fonts/thmanyah/thmanyahsans-Regular.woff2'); return r.ok && /font|octet/.test(r.headers.get('content-type') ?? '') })
  if (installed) {
    await page.evaluate(() => document.fonts.load('400 16px "Thmanyah Sans"', 'مرحبا'))
    expect(await page.evaluate(() => document.fonts.check('400 16px "Thmanyah Sans"', 'مرحبا'))).toBe(true)
  }

  await setLanguage('en')
  await page.evaluate(() => localStorage.setItem('lifeos-language', 'en'))
  await page.goto('/')
  await expect(page.locator('.now-card')).toBeVisible()
  const en = await families()
  expect(en.dir).toBe('ltr')
  expect(en.body.startsWith('Inter')).toBe(true)
})
