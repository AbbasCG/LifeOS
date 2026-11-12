import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Link, useInRouterContext } from 'react-router'
import { CalendarClock, CalendarDays } from 'lucide-react'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useAnimatedClose } from '../../lib/useAnimatedClose'
import { announce } from '../../lib/announce'
import { calendarLink, displayZone } from '../../lib/taskSchedule'
import { conflictDay, conflictSentence, conflictTitle, overlapText, rangeText, type ConflictItem, type ScheduleConflict, type Slot } from '../../lib/scheduleConflict'

/**
 * ScheduleConflictDialog: "this time is already booked". Shown when the server refuses a booking with 422 `schedule_conflict`.
 * It states the problem in plain words (24-hour times, the other item's title, day and overlap), lists up to 5 conflicts and
 * offers the way out. It is NOT an alert(): a modal <dialog role="alertdialog">, focus trapped, announced once politely.
 *
 * API (stable):
 *   <ScheduleConflictDialog
 *      conflict={ScheduleConflict}          // from parseConflict(error) in lib/scheduleConflict.ts (null for any other error)
 *      onChoose={() => void}                // "Choose another time": called AFTER the dialog is closed and unmounted, so the caller can
 *                                           //   put focus on its time field / chips (the dialog does not restore focus in this case)
 *      onUseSuggestion={(slot) => void}     // optional; the button is shown only when conflict.suggestion is not null. Called once;
 *                                           //   the caller applies the slot through its scheduling path (useTaskScheduling) and
 *                                           //   closes the dialog (its onClose). The button is disabled after the first press.
 *      onClose={() => void}                 // dismissed (Esc, x, backdrop, "View"): the caller clears the conflict state.
 *                                           //   Focus goes back to the control that opened the flow. Always called when it closes.
 *      title?: string />                    // overrides the default heading
 *
 * Most callers do not render it by hand: useTaskScheduling({ onChooseTime }) keeps the conflict, renders this dialog through
 * `scheduling.conflictDialog` (put that node anywhere in your JSX) and applies the suggestion itself.
 * Also exported from lib/scheduleConflict.ts: parseConflict, conflictSentence, conflictTitle.
 */
export type ScheduleConflictDialogProps = { conflict: ScheduleConflict; onChoose: () => void; onUseSuggestion?: (slot: Slot) => void; onClose: () => void; title?: string }

const TIMES = /(\d{2}:\d{2}(?:–\d{2}:\d{2})?)/g
/** Times keep their own direction inside an Arabic sentence. */
const withTimes = (text: string): ReactNode[] => text.split(TIMES).map((part, i) => (i % 2 ? <bdi key={i}>{part}</bdi> : part))

function AppLink({ to, children, onClick }: { to: string; children: ReactNode; onClick: () => void }) {
  return useInRouterContext() ? <Link to={to} className="filter-chip" onClick={onClick}>{children}</Link> : <a href={to} className="filter-chip" onClick={onClick}>{children}</a>
}

export function ScheduleConflictDialog({ conflict, onChoose, onUseSuggestion, onClose, title }: ScheduleConflictDialogProps) {
  const t = useText(), { language } = useLanguage(), titleId = useId(), ref = useRef<HTMLDialogElement>(null)
  const zone = displayZone(), how = useRef<'close' | 'choose'>('close'), used = useRef(false)
  const latest = useRef({ onChoose, onClose })
  useEffect(() => { latest.current = { onChoose, onClose } })
  const close = useAnimatedClose(ref, () => latest.current.onClose())
  const heading = title ?? conflictTitle(conflict, t), sentence = conflictSentence(conflict, t, language, zone)
  const link = conflict.conflicts.find(c => c.kind !== 'external' && c.event_id != null)
  const slot = conflict.suggestion, sameDay = !slot || conflictDay(slot.starts_at, t, language, zone) === conflictDay(conflict.requested.starts_at, t, language, zone)

  useEffect(() => {
    const dialog = ref.current, previous = document.activeElement as HTMLElement | null
    dialog?.showModal(); dialog?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true })
    announce(`${heading} ${sentence}`)   // once, politely: the dialog does not describe itself, so it is not read twice
    return () => {
      dialog?.close()
      // "Choose another time" hands focus to the caller (after this unmount); every other way out returns it to where the flow began.
      if (how.current === 'choose') window.setTimeout(() => latest.current.onChoose(), 0)
      else previous?.focus?.({ preventScroll: true })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const row = (c: ConflictItem, i: number) => <li key={`${c.id ?? c.event_id ?? i}-${c.starts_at}`}>
    <bdi className="sc-title">{c.title || t('Busy', 'مشغول', 'Bezet')}</bdi>
    <span className="muted"> · <bdi>{conflictDay(c.starts_at, t, language, zone)}</bdi> <bdi>{rangeText(c, language, zone)}</bdi> · {overlapText(c.overlap_minutes, t)}</span>
  </li>

  return <dialog ref={ref} role="alertdialog" aria-labelledby={titleId} className="os-dialog sc-dialog" onCancel={e => { e.preventDefault(); e.stopPropagation(); close() }}>
    <header className="row"><h2 id={titleId}>{heading}</h2><button type="button" className="quiet" onClick={close} aria-label={t('Close', 'إغلاق', 'Sluiten')}>×</button></header>
    <p className="sc-body">{withTimes(sentence)}</p>
    <ul className="sc-list">{conflict.conflicts.map(row)}</ul>
    {slot && onUseSuggestion && <button type="button" className="filter-chip sc-suggest" onClick={() => { if (used.current) return; used.current = true; onUseSuggestion(slot) }}>
      <CalendarClock size={14} aria-hidden="true" />{t('Suggest the first free time', 'اقتراح أول وقت متاح', 'Eerste vrije tijd voorstellen')}: <bdi>{sameDay ? '' : `${conflictDay(slot.starts_at, t, language, zone)} `}{rangeText(slot, language, zone)}</bdi></button>}
    <div className="toolbar sc-actions">
      {link && <AppLink to={calendarLink(link.starts_at, link.event_id, zone)} onClick={close}><CalendarDays size={14} aria-hidden="true" />{t('View the conflicting item', 'عرض المهمة المتعارضة', 'Bekijk het conflicterende item')}</AppLink>}
      <button type="button" className="primary" data-autofocus onClick={() => { how.current = 'choose'; close() }}>{t('Choose another time', 'اختيار وقت آخر', 'Kies een andere tijd')}</button>
    </div>
  </dialog>
}
