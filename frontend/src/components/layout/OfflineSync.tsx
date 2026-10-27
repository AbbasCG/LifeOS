import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckSquare, CloudUpload, Heart, Plus, Send, Trash2 } from 'lucide-react'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { useOnline } from '../../lib/pwa'
import { discard, OPEN_SYNC, sendAllPending, sendPending, usePending, type Pending } from '../../lib/offline'
import { TASKS_CHANGED } from '../../lib/quickAdd'
import { HABITS_CHANGED } from '../../lib/quickActions'
import { BottomSheet } from '../visual'

const refreshLists = () => { window.dispatchEvent(new Event(TASKS_CHANGED)); window.dispatchEvent(new Event(HABITS_CHANGED)) }

/**
 * "Waiting to sync": what was kept on this device while offline. A small pill shows the count; nothing is sent until
 * the user opens the list and taps Send. Coming back online only suggests reviewing it.
 */
export default function OfflineSync() {
  const t = useText(), toast = useToast(), online = useOnline(), items = usePending()
  const [open, setOpen] = useState(false)
  const wasOnline = useRef(online)
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(OPEN_SYNC, show)
    return () => window.removeEventListener(OPEN_SYNC, show)
  }, [])
  // Back online with something waiting: suggest a review, never send by itself.
  useEffect(() => {
    if (online && !wasOnline.current && items.length > 0) toast(t(`Back online. ${items.length} change(s) waiting to sync.`, `عاد الاتصال. ${items.length} تغيير بانتظار المزامنة.`), 'info', { label: t('Review', 'مراجعة'), onClick: () => setOpen(true) })
    wasOnline.current = online
  }, [online, items.length, t, toast])

  if (items.length === 0 && !open) return null
  const conflicts = items.filter(i => i.state === 'conflict').length
  return <>
    {items.length > 0 && <button type="button" className={`sync-pill ${conflicts ? 'has-conflict' : ''}`} onClick={() => setOpen(true)}>
      {conflicts ? <AlertTriangle size={15} aria-hidden="true" /> : <CloudUpload size={15} aria-hidden="true" />}
      {t(`${items.length} waiting to sync`, `${items.length} بانتظار المزامنة`)}
    </button>}
    {open && <SyncSheet items={items} online={online} onClose={() => setOpen(false)} />}
  </>
}

function SyncSheet({ items, online, onClose }: { items: Pending[]; online: boolean; onClose: () => void }) {
  const t = useText(), toast = useToast(), { language } = useLanguage()
  const [busy, setBusy] = useState(false)
  const kinds = {
    'task.create': [Plus, t('New task', 'مهمة جديدة')],
    'task.complete': [CheckSquare, t('Completed', 'منجزة')],
    'habit.log': [Heart, t('Habit', 'عادة')],
  } as const
  const reason = (i: Pending) => i.reason === 'deleted' ? t('No longer exists (deleted on another device).', 'لم تعد موجودة (حُذفت على جهاز آخر).')
    : i.reason === 'changed' ? t('Changed on another device since then.', 'تغيّرت على جهاز آخر منذ ذلك الحين.')
      : i.message || t('The server did not accept it.', 'لم يقبلها الخادم.')
  async function sendAll() {
    setBusy(true)
    try {
      const s = await sendAllPending()
      refreshLists()
      if (s.offline) toast(t('Still offline. The rest stays on this device.', 'ما زلت غير متصل. يبقى الباقي على هذا الجهاز.'), 'error')
      else toast(s.conflict
        ? t(`${s.sent + s.already} sent. ${s.conflict} need(s) your decision.`, `أُرسل ${s.sent + s.already}. ${s.conflict} يحتاج قرارك.`)
        : t(`${s.sent + s.already} change(s) sent.`, `أُرسل ${s.sent + s.already} تغيير.`))
    } finally { setBusy(false) }
  }
  async function force(item: Pending) {
    setBusy(true)
    try { const r = await sendPending(item, true); refreshLists(); if (r === 'sent') toast(t('Sent.', 'أُرسل.')) } finally { setBusy(false) }
  }
  return <BottomSheet title={t('Waiting to sync', 'بانتظار المزامنة')} onClose={onClose} footer={<>
    <span className="muted small sync-note">{online ? t('Nothing is sent until you tap Send.', 'لا يُرسل شيء قبل الضغط على «إرسال».') : t('You’re offline. Send when you’re back online.', 'أنت غير متصل. أرسل عند عودة الاتصال.')}</span>
    <button type="button" className="primary" disabled={!online || busy || !items.some(i => i.state === 'waiting')} onClick={() => void sendAll()}><Send size={16} className="flip-rtl" />{t('Send all', 'إرسال الكل')}</button>
  </>}>
    {items.length === 0 ? <p className="muted">{t('Everything is in sync.', 'كل شيء متزامن.')}</p> : <ul className="sync-list">{items.map(item => {
      const [Icon, kind] = kinds[item.kind]
      return <li key={item.id} className={`state-${item.state}`}>
        <span className="sync-icon"><Icon size={16} aria-hidden="true" /></span>
        <span className="sync-body"><strong>{item.label}</strong><small className="muted">{kind} · {new Date(item.created_at).toLocaleString(language, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</small>
          {item.state === 'conflict' && <small className="sync-conflict"><AlertTriangle size={12} aria-hidden="true" />{reason(item)}</small>}
          {item.state === 'conflict' && item.kind === 'task.complete' && item.reason === 'changed' && <button type="button" className="quiet" disabled={!online || busy} onClick={() => void force(item)}>{t('Complete anyway', 'أنجزها على أي حال')}</button>}
        </span>
        <button type="button" className="icon-button" disabled={busy} onClick={() => discard(item.id)} aria-label={t(`Discard “${item.label}”`, `تجاهل «${item.label}»`)}><Trash2 size={15} /></button>
      </li>
    })}</ul>}
  </BottomSheet>
}
