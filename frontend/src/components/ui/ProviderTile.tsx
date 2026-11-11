import type { LucideIcon } from 'lucide-react'

/** Short, neutral monograms (never a brand logo). Any other provider id falls back to the first letter of its name. */
const MONOGRAM: Record<string, string> = { google: 'Gc', outlook: 'Oc', google_tasks: 'Gt', microsoft_todo: 'Mt', todoist: 'Td', ics: 'Ic', ics_feed: 'Ic', notion: 'No', gmail: 'Gm', outlook_mail: 'Om', apple_calendar: 'Ac' }

/** The decorative mark of one provider: a monogram, a small category badge and, for a connected account, a health dot. The name is always written next to it. */
export function ProviderTile({ id, label, icon: Icon, health, muted }: { id: string; label: string; icon: LucideIcon; health?: 'ok' | 'warn' | 'bad' | 'idle'; muted?: boolean }) {
  return <span className={`provider-tile${muted ? ' is-muted' : ''}`} data-p={id} data-s={health} aria-hidden="true">
    <span className="pt-letters">{MONOGRAM[id] ?? Array.from(label.trim())[0]?.toUpperCase() ?? '?'}</span>
    <span className="pt-cat"><Icon aria-hidden="true" /></span>
  </span>
}
