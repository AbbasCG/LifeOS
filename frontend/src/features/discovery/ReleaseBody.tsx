import { AlertTriangle, ArrowUpCircle, Sparkles, Wrench, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router'
import { useText } from '../../lib/i18n'
import type { DiscoveryItem, ItemType } from '../../lib/discovery'

const ORDER: ItemType[] = ['important', 'new', 'improved', 'fixed']
const ICONS: Record<ItemType, LucideIcon> = { important: AlertTriangle, new: Sparkles, improved: ArrowUpCircle, fixed: Wrench }

/** The items of one release, grouped as New / Improved / Fixed / Important, with media and a "Try now" where the server says it can work. */
export function ReleaseBody({ items, onTry, busy }: { items: DiscoveryItem[]; onTry?: (item: DiscoveryItem) => void; busy?: string | null }) {
  const t = useText()
  const labels: Record<ItemType, string> = {
    important: t('Important', 'مهم', 'Belangrijk'), new: t('New', 'جديد', 'Nieuw'),
    improved: t('Improved', 'تحسين', 'Verbeterd'), fixed: t('Fixed', 'إصلاح', 'Opgelost'),
  }
  return <div className="rel-body">
    {ORDER.map(type => {
      const group = items.filter(i => i.type === type)
      if (!group.length) return null
      const Icon = ICONS[type]
      return <div key={type} className="rel-group">
        <h3 className={`rel-badge rel-${type}`}><Icon size={15} aria-hidden="true" />{labels[type]}</h3>
        <ul>
          {group.map((item, index) => <li key={`${type}-${index}`} className="rel-item">
            <h4>{item.title}{item.is_new && <span className="rel-new">{t('New', 'جديد', 'Nieuw')}</span>}</h4>
            <p>{item.body}</p>
            {item.image && <img className="rel-media" src={item.image.src} alt={item.image.alt} loading="lazy" decoding="async" />}
            {item.video && <video className="rel-media" controls preload="none" playsInline muted poster={item.video.poster} aria-label={item.video.label}>
              <source src={item.video.src} />
              {item.video.captions && <track kind="captions" src={item.video.captions} default />}
            </video>}
            <div className="rel-actions">
              {item.can_try && onTry && <button type="button" className="primary" disabled={busy === item.feature} onClick={() => onTry(item)}>{t('Try now', 'جرّبها الآن', 'Probeer nu')}</button>}
              {item.link && <Link className="quiet" to={item.link}>{t('Learn more', 'اعرف المزيد', 'Meer weten')}</Link>}
            </div>
          </li>)}
        </ul>
      </div>
    })}
  </div>
}
