import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']

/**
 * Waits until what is on screen has stopped moving: every finite animation under `scope` (or the whole page) has finished and two frames
 * have been drawn, so script-driven motion that does not use the Web Animations API has had its last frame too. Looped animations
 * (spinners, skeleton shimmer) never finish and are not waited for. Axe measures colour contrast on the rendered pixels' computed
 * styles, and a card halfway through its fade-in has a smaller opacity than the one a person reads, which gave random contrast failures.
 */
export async function settle(page: Page, scope?: string) {
  await page.evaluate(async selector => {
    const root = selector ? document.querySelector(selector) : document.documentElement
    if (!root) return
    for (let round = 0; round < 5; round++) {
      const running = root.getAnimations({ subtree: true }).filter(a => a.playState !== 'finished' && a.effect?.getComputedTiming().iterations !== Infinity)
      if (!running.length) break
      await Promise.all(running.map(a => a.finished.catch(() => undefined)))
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  }, scope ?? null)
}

/**
 * Every accessibility violation on the settled page (or inside `scope`), one line per failing element, so a failure names all of them:
 * `color-contrast [serious] .tour-card h2 — Element has insufficient color contrast of 2.3 …`. An empty list means none.
 */
export async function a11yViolations(page: Page, scope?: string): Promise<string[]> {
  await settle(page, scope)
  const builder = new AxeBuilder({ page }).withTags(AXE_TAGS)
  const { violations } = await (scope ? builder.include(scope) : builder).analyze()
  return violations.flatMap(v => v.nodes.map(node => {
    const why = (node.failureSummary ?? v.help).split('\n').slice(1).map(line => line.trim()).filter(Boolean).join('; ') || v.help
    return `${v.id} [${v.impact ?? 'n/a'}] ${node.target.join(' > ')} — ${why}`
  }))
}
