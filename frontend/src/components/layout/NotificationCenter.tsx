import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Bell, BellRing, CalendarClock, CheckCheck, AlarmClock, Timer, Trash2, ClipboardList, AlertTriangle } from 'lucide-react'
import { api, type InboxNotification } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { Dialog, ErrorMessage } from '../ui/Shared'

const icons: Record<string, typeof Bell> = { reminder: AlarmClock, due: CalendarClock, overdue: AlertTriangle, event: CalendarClock, focus: Timer, planning: ClipboardList, review: ClipboardList }
const POLL_MS = 60_000

export default function NotificationCenter() {
  const t = useText(), { language } = useLanguage(), navigate = useNavigate()
  const [unread, setUnread] = useState(0), [items, setItems] = useState<InboxNotification[] | null>(null), [error, setError] = useState('')
  const refreshCount = useCallback(() => {
    if (document.visibilityState === 'hidden') return
    api<{ unread_count: number }>('/api/notifications/unread').then(v => setUnread(v.unread_count)).catch(() => {})
  }, [])
  useEffect(() => {
    refreshCount()
    const id = setInterval(refreshCount, POLL_MS)
    document.addEventListener('visibilitychange', refreshCount)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', refreshCount) }
  }, [refreshCount])
  async function run<T extends { unread_count: number }>(fn: () => Promise<T>) {
    try { const result = await fn(); setUnread(result.unread_count); return result } catch (e) { setError((e as Error).message) }
  }
  async function open() {
    setError('')
    const page = await run(() => api<{ data: InboxNotification[]; unread_count: number }>('/api/notifications'))
    if (page) setItems(page.data)
  }
  async function select(item: InboxNotification) {
    if (!item.read_at) await run(() => api<{ unread_count: number }>(`/api/notifications/${item.id}`, 'PATCH'))
    setItems(null)
    if (item.link) navigate(item.link)
  }
  const relative = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  function ago(iso: string, now: number) {
    const minutes = Math.round((new Date(iso).getTime() - now) / 60000)
    if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute')
    if (Math.abs(minutes) < 1440) return relative.format(Math.round(minutes / 60), 'hour')
    return relative.format(Math.round(minutes / 1440), 'day')
  }
  const now = new Date().getTime()
  return <>
    <button className="icon-button badge-host" aria-label={unread ? t(`Notifications, ${unread} unread`, `الإشعارات، ${unread} غير مقروءة`) : t('Notifications', 'الإشعارات')} onClick={() => void open()}>
      {unread ? <BellRing size={20} /> : <Bell size={20} />}{unread > 0 && <span className="count-badge">{unread > 99 ? '99+' : unread}</span>}
    </button>
    {items && <Dialog title={t('Notifications', 'الإشعارات')} onClose={() => setItems(null)}>
      <ErrorMessage error={error} />
      {items.length > 0 && <div className="row notification-actions"><span className="muted">{t(`${unread} unread`, `${unread} غير مقروءة`)}</span><button className="quiet" disabled={!unread} onClick={() => void run(() => api<{ unread_count: number }>('/api/notifications/read-all', 'POST')).then(() => setItems(items.map(i => ({ ...i, read_at: i.read_at || new Date().toISOString() }))))}><CheckCheck size={16} />{t('Mark all read', 'تعليم الكل كمقروء')}</button></div>}
      {!items.length ? <p className="empty">{t('You’re all caught up.', 'أنت مطّلع على كل شيء.')}</p> : <ul className="notification-list">{items.map(item => {
        const Icon = icons[item.kind] || Bell
        return <li key={item.id} className={item.read_at ? 'read' : 'unread'}>
          <button className="notification-main" onClick={() => void select(item)}><span className={`notification-icon kind-${item.kind}`}><Icon size={16} /></span><span><strong>{item.title}</strong><small className="muted">{ago(item.created_at, now)}</small></span>{!item.read_at && <span className="dot" aria-label={t('Unread', 'غير مقروء')} />}</button>
          <button className="icon-button" aria-label={t('Delete notification', 'حذف الإشعار')} onClick={() => void run(() => api<{ unread_count: number }>(`/api/notifications/${item.id}`, 'DELETE')).then(r => { if (r) setItems(items.filter(i => i.id !== item.id)) })}><Trash2 size={15} /></button>
        </li>
      })}</ul>}
    </Dialog>}
  </>
}
