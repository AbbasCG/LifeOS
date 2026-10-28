/**
 * Says something to screen-reader users without moving focus (V26), through one polite live region shared by the
 * whole app. Visual feedback (toasts) keeps its own live region; this is for changes that have no toast, like a new
 * page or a filtered list.
 */
let region: HTMLElement | null = null
let timer: ReturnType<typeof setTimeout> | undefined

export function announce(message: string) {
  if (typeof document === 'undefined' || !message) return
  if (!region || !region.isConnected) {
    region = document.createElement('div')
    region.className = 'sr-only'
    region.setAttribute('role', 'status')
    region.setAttribute('aria-live', 'polite')
    region.dataset.announcer = ''
    document.body.appendChild(region)
  }
  const target = region
  // Clearing first makes the same message be read again when it repeats.
  target.textContent = ''
  clearTimeout(timer)
  timer = setTimeout(() => { target.textContent = message }, 60)
}

/** The text of the page's main heading, once it has rendered (lazy pages may take a moment). */
export function whenHeading(found: (text: string) => void, tries = 25) {
  const heading = document.querySelector('main h1')
  const text = heading?.textContent?.replace(/\s+/g, ' ').trim()
  if (text) { found(text); return () => {} }
  if (tries <= 0) return () => {}
  let cancel = () => {}
  const id = setTimeout(() => { cancel = whenHeading(found, tries - 1) }, 80)
  return () => { clearTimeout(id); cancel() }
}
