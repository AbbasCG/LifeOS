/**
 * Keyboard behaviour for every button-based radio group in the app (V26), installed once at the root:
 * - one Tab stop per group (the checked radio, or the first enabled one), so Tab moves between groups;
 * - arrow keys move to the next or previous radio and select it, Home and End jump to the ends, and Left/Right
 *   follow reading direction (reversed in Arabic);
 * - a group marked `data-arrow-select="false"` only moves focus on arrows, for groups where picking an option saves
 *   straight away; Enter or Space then picks.
 * Native `<input type="radio">` groups already behave this way and are left alone.
 */
const RADIO = '[role="radio"]'

function radiosOf(group: Element) {
  return [...group.querySelectorAll<HTMLElement>(RADIO)].filter(r => r.tagName !== 'INPUT' && r.closest('[role="radiogroup"]') === group)
}
const enabled = (r: HTMLElement) => !r.hasAttribute('disabled') && r.getAttribute('aria-disabled') !== 'true'

/** Makes exactly one radio in the group reachable with Tab. */
export function syncGroup(group: Element) {
  const radios = radiosOf(group)
  if (!radios.length) return
  const usable = radios.filter(enabled)
  const focused = radios.find(r => r === document.activeElement)
  const stop = focused ?? usable.find(r => r.getAttribute('aria-checked') === 'true') ?? usable[0]
  for (const r of radios) r.tabIndex = r === stop ? 0 : -1
}

function onKey(e: KeyboardEvent) {
  if (e.altKey || e.ctrlKey || e.metaKey) return
  const radio = (e.target as Element | null)?.closest?.<HTMLElement>(RADIO)
  const group = radio?.closest('[role="radiogroup"]')
  if (!radio || !group || radio.tagName === 'INPUT') return
  const radios = radiosOf(group).filter(enabled)
  const index = radios.indexOf(radio)
  if (index < 0 || radios.length < 2) return
  const rtl = getComputedStyle(group).direction === 'rtl'
  const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }
  let next: number
  if (e.key in step) next = (index + step[e.key] + radios.length) % radios.length
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = radios.length - 1
  else return
  e.preventDefault()
  const target = radios[next]
  for (const r of radiosOf(group)) r.tabIndex = r === target ? 0 : -1
  target.focus()
  if ((group as HTMLElement).dataset.arrowSelect !== 'false') target.click()
}

/** Installs the behaviour on a document; returns the uninstaller. */
export function installRadioGroups(root: Document = document) {
  const syncAll = () => root.querySelectorAll('[role="radiogroup"]').forEach(syncGroup)
  const observer = new MutationObserver(syncAll)
  observer.observe(root.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-checked', 'disabled', 'role'] })
  root.addEventListener('keydown', onKey)
  // A Tab back into a group lands on the checked option, not the one last focused by arrows.
  const onFocusOut = (e: FocusEvent) => { const group = (e.target as Element | null)?.closest?.('[role="radiogroup"]'); if (group && !group.contains(e.relatedTarget as Node | null)) queueMicrotask(() => syncGroup(group)) }
  root.addEventListener('focusout', onFocusOut)
  syncAll()
  return () => { observer.disconnect(); root.removeEventListener('keydown', onKey); root.removeEventListener('focusout', onFocusOut) }
}
