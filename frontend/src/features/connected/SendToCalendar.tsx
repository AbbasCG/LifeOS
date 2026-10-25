import { useState } from 'react'
import { CheckCircle2, AlertTriangle } from 'lucide-react'
import { useText } from '../../lib/i18n'
import { Dialog } from '../../components/ui/Shared'
import { sourceName } from '../../lib/sources'
import { WritePreview } from './WritePreview'
import type { WriteData, WriteOp } from '../../lib/calendarWrite'

/** Add one LifeOS event to a connected calendar, or update / remove the copy LifeOS added — always via a preview. */
export function SendToCalendar({ eventId, title, data, onClose, onChanged }: { eventId: number; title: string; data: WriteData; onClose: () => void; onChanged: () => void }) {
  const t = useText()
  const [pending, setPending] = useState<{ account: number; op: WriteOp; link?: number } | null>(null)
  return <Dialog title={t(`Send “${title}” to a calendar`, `إرسال «${title}» إلى تقويم`)} onClose={onClose}>
    <ul className="send-targets">{data.targets.map(target => {
      const link = data.links.find(l => l.account_id === target.id && l.event_id === eventId)
      const name = `${sourceName(target.provider, t, true)} · ${target.calendar_name ?? ''}`
      const open = pending?.account === target.id
      return <li key={target.id} className={open ? 'open' : ''}>
        <div className="send-row">
          <div><strong>{name}</strong><small className="muted" dir="ltr">{target.email}</small></div>
          {!link ? <button className="primary" disabled={open} onClick={() => setPending({ account: target.id, op: 'create' })}>{t('Add', 'إضافة')}</button>
            : <div className="toolbar">
              {link.in_sync ? <span className="chip ok"><CheckCircle2 size={12} />{t('Added, up to date', 'مُضاف ومحدّث')}</span> : <><span className="chip warn"><AlertTriangle size={12} />{t('Copy is out of date', 'النسخة قديمة')}</span><button className="primary" disabled={open} onClick={() => setPending({ account: target.id, op: 'update', link: link.id })}>{t('Update', 'تحديث')}</button></>}
              <button className="quiet" disabled={open} onClick={() => setPending({ account: target.id, op: 'delete', link: link.id })}>{t('Remove', 'إزالة')}</button>
            </div>}
        </div>
        {open && <WritePreview op={pending.op} accountId={target.id} eventId={pending.op === 'delete' ? null : eventId} linkId={pending.link} onCancel={() => setPending(null)} onDone={() => { setPending(null); onChanged() }} />}
      </li>
    })}</ul>
  </Dialog>
}
