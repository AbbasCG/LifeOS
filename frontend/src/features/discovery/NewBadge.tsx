import { useSyncExternalStore } from 'react'
import { useText } from '../../lib/i18n'
import { getNewFeatures, routePath, subscribeNew } from '../../lib/discovery'

/** A small "New" mark on a menu item whose feature the person has not tried yet (and only for a limited time, set by the content). */
export function NewBadge({ to }: { to: string }) {
  const t = useText(), list = useSyncExternalStore(subscribeNew, getNewFeatures)
  if (!list.some(f => routePath(f.route) === to)) return null
  return <span className="new-badge" data-testid="new-badge">{t('New', 'جديد', 'Nieuw')}</span>
}
