import { test, expect } from './fixtures'

/**
 * Real speech recognition needs a microphone and the browser's speech service, so the page gets a stand-in that
 * "hears" a fixed phrase. What is tested is LifeOS's part: consent, the text landing in the composer, nothing being
 * sent, and the account switch.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class FakeRecognition {
      lang = ''; continuous = false; interimResults = false; maxAlternatives = 1
      onresult: ((e: unknown) => void) | null = null; onerror: ((e: unknown) => void) | null = null; onend: (() => void) | null = null
      start() {
        (window as unknown as { lastSpeechLang: string }).lastSpeechLang = this.lang
        const phrase = this.lang.startsWith('ar') ? 'خطط أسبوعي' : 'plan my week around my meetings'
        setTimeout(() => this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: phrase.split(' ').slice(0, 2).join(' ') }], { isFinal: false })] }), 150)
        setTimeout(() => { this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: phrase }], { isFinal: true })] }); this.onend?.() }, 500)
      }
      stop() { this.onend?.() }
      abort() { this.onend?.() }
    }
    // Chromium has both the prefixed and the standard name; LifeOS prefers the standard one.
    Object.assign(window, { SpeechRecognition: FakeRecognition, webkitSpeechRecognition: FakeRecognition })
  })
})

test('dictation fills the Copilot message after consent and never sends by itself', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/assistant')
  await page.evaluate(() => localStorage.removeItem('lifeos-voice-consent'))
  const mic = page.getByRole('button', { name: 'Dictate a message' })
  await mic.click()
  const dialog = page.locator('dialog.os-dialog', { hasText: 'Dictate with your browser?' })
  await expect(dialog).toContainText('LifeOS never receives or stores audio')
  await dialog.getByRole('button', { name: 'Allow and start' }).click()

  const composer = page.getByRole('textbox', { name: 'Message' })
  await expect(composer).toHaveValue('plan my week around my meetings')
  expect(await page.evaluate(() => (window as unknown as { lastSpeechLang: string }).lastSpeechLang)).toMatch(/^en-/)
  await expect(page.locator('.chat-turn')).toHaveCount(0)
  await expect(mic).toHaveAttribute('aria-pressed', 'false')

  // A second dictation adds to what is there, without asking again.
  await mic.click()
  await expect(composer).toHaveValue('plan my week around my meetings plan my week around my meetings')
  await expect(dialog).toHaveCount(0)
  await page.evaluate(() => localStorage.removeItem('lifeos-voice-consent'))
})

test('voice input can be switched off for the account in the AI Control Center (Arabic)', async ({ page, setLanguage }) => {
  await setLanguage('ar')
  try {
    await page.goto('/settings/ai')
    const toggle = page.getByRole('switch', { name: 'الإدخال الصوتي في المساعد' })
    await expect(toggle).toBeChecked()
    await page.locator('label.switch', { has: toggle }).click()
    await expect(toggle).not.toBeChecked()
    await page.goto('/assistant')
    await expect(page.getByRole('textbox', { name: 'الرسالة' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'إملاء رسالة' })).toHaveCount(0)

    await page.goto('/settings/ai')
    await page.locator('label.switch', { has: page.getByRole('switch', { name: 'الإدخال الصوتي في المساعد' }) }).click()
    await expect(page.getByRole('switch', { name: 'الإدخال الصوتي في المساعد' })).toBeChecked()
    await page.goto('/assistant')
    await expect(page.getByRole('button', { name: 'إملاء رسالة' })).toBeVisible()
  } finally {
    await page.evaluate(async () => {
      const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
      await fetch('/api/settings', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: JSON.stringify({ voice_input: true }) })
    })
    await setLanguage('en')
  }
})
