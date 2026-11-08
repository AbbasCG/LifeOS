import { useSyncExternalStore } from 'react'
import { useText } from '../../lib/i18n'
import { getNewFeatures, getUnseenUpdates, routePath, subscribeNew, subscribeUnseen } from '../../lib/discovery'

/**
 * A small mark on a menu item: "New" on the screen of a feature the person has not tried yet (for a limited time, set by the content), and on "What's new"
 * the number of updates they have not seen yet.
 */
export function NewBadge({ to }: { to: string }) {
  const t = useText(), list = useSyncExternalStore(subscribeNew, getNewFeatures), unseen = useSyncExternalStore(subscribeUnseen, getUnseenUpdates)
  if (to === '/updates') {
    if (unseen <= 0) return null
    return <span className="new-badge" data-testid="unseen-badge" aria-label={t(`${unseen} updates you have not seen`, `${unseen} تحديثات لم تطّلع عليها`, `${unseen} updates die je nog niet zag`)}>{unseen}</span>
  }
  if (!list.some(f => routePath(f.route) === to)) return null
  return <span className="new-badge" data-testid="new-badge">{t('New', 'جديد', 'Nieuw')}</span>
}
