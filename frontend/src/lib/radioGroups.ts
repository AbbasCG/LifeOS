/**
 * Keyboard behaviour for every button-based radio group and tab list in the app (V26, tabs added in V60), installed once at the root:
 * - one Tab stop per group (the checked radio / selected tab, or the first enabled one), so Tab moves between groups;
 * - arrow keys move to the next or previous item and select it, Home and End jump to the ends, and Left/Right follow reading
 *   direction (reversed in Arabic). Radio groups also answer Up and Down; a tab list is horizontal, so it does not;
 * - a group marked `data-arrow-select="false"` only moves focus on arrows, for groups where picking an option saves
 *   straight away; Enter or Space then picks. An item that opens a dialog (`aria-haspopup`, e.g. the Quick Add date tile)
 *   never opens it from an arrow key, only from Enter or Space.
 * Native `<input type="radio">` groups already behave this way and are left alone.
 */
type Kind = { group: string; item: string; on: 'aria-checked' | 'aria-selected'; vertical: boolean }
const KINDS: Kind[] = [
  { group: '[role="radiogroup"]', item: '[role="radio"]', on: 'aria-checked', vertical: true },
  { group: '[role="tablist"]', item: '[role="tab"]', on: 'aria-selected', vertical: false },
]
const GROUPS = KINDS.map(k => k.group).join(',')
const ITEMS = KINDS.map(k => k.item).join(',')
const kindOf = (group: Element) => KINDS.find(k => group.matches(k.group))

function itemsOf(group: Element) {
  const kind = kindOf(group)
  if (!kind) return []
  return [...group.querySelectorAll<HTMLElement>(kind.item)].filter(r => r.tagName !== 'INPUT' && r.closest(kind.group) === group)
}
const enabled = (r: HTMLElement) => !r.hasAttribute('disabled') && r.getAttribute('aria-disabled') !== 'true'

/** Makes exactly one item in the group reachable with Tab. */
export function syncGroup(group: Element) {
  const kind = kindOf(group), items = itemsOf(group)
  if (!kind || !items.length) return
  const usable = items.filter(enabled)
  const focused = items.find(r => r === document.activeElement)
  const stop = focused ?? usable.find(r => r.getAttribute(kind.on) === 'true') ?? usable[0]
  for (const r of items) r.tabIndex = r === stop ? 0 : -1
}

function onKey(e: KeyboardEvent) {
  if (e.altKey || e.ctrlKey || e.metaKey) return
  const item = (e.target as Element | null)?.closest?.<HTMLElement>(ITEMS)
  const group = item?.closest(GROUPS)
  const kind = group ? kindOf(group) : undefined
  if (!item || !group || !kind || !item.matches(kind.item) || item.tagName === 'INPUT') return
  const items = itemsOf(group).filter(enabled)
  const index = items.indexOf(item)
  if (index < 0 || items.length < 2) return
  const rtl = getComputedStyle(group).direction === 'rtl'
  const step: Record<string, number> = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ...(kind.vertical ? { ArrowDown: 1, ArrowUp: -1 } : {}) }
  let next: number
  if (e.key in step) next = (index + step[e.key] + items.length) % items.length
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = items.length - 1
  else return
  e.preventDefault()
  const target = items[next]
  for (const r of itemsOf(group)) r.tabIndex = r === target ? 0 : -1
  target.focus()
  if ((group as HTMLElement).dataset.arrowSelect !== 'false' && !target.hasAttribute('aria-haspopup')) target.click()
}

/** Installs the behaviour on a document; returns the uninstaller. */
export function installRadioGroups(root: Document = document) {
  const syncAll = () => root.querySelectorAll(GROUPS).forEach(syncGroup)
  const observer = new MutationObserver(syncAll)
  observer.observe(root.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-checked', 'aria-selected', 'disabled', 'role'] })
  root.addEventListener('keydown', onKey)
  // A Tab back into a group lands on the checked option, not the one last focused by arrows.
  const onFocusOut = (e: FocusEvent) => { const group = (e.target as Element | null)?.closest?.(GROUPS); if (group && !group.contains(e.relatedTarget as Node | null)) queueMicrotask(() => syncGroup(group)) }
  root.addEventListener('focusout', onFocusOut)
  syncAll()
  return () => { observer.disconnect(); root.removeEventListener('keydown', onKey); root.removeEventListener('focusout', onFocusOut) }
}
