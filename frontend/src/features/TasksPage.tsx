import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useSearchParams } from 'react-router'
import { AnimatePresence, m } from 'motion/react'
import { Bell, Check, CheckSquare, ChevronDown, Columns3, List, ListChecks, Pencil, Play, Plus, Search, SlidersHorizontal, Timer, Trash2 } from 'lucide-react'
import { api, type RecordItem } from '../lib/api'
import { useRecords } from '../lib/hooks'
import { announce } from '../lib/announce'
import { useText } from '../lib/i18n'
import { useLanguage } from '../contexts/LanguageContext'
import { useToast } from '../lib/toast'
import { Dialog, ErrorMessage, Skeleton } from '../components/ui/Shared'
import { DueChip, EmptyNote, PageHead, PriorityMark } from '../components/visual'
import { TASKS_CHANGED, dueFor, openQuickAdd, type When } from '../lib/quickAdd'
import { RecordForm, useStatusLabel } from './ResourcePage'
import { ConnectedTasksPanel } from './connected/ConnectedTasksPanel'
import { useStartFocus } from '../lib/useStartFocus'
import { completeTaskOrQueue } from '../lib/offline'

type Filter = 'open' | 'overdue' | 'today' | 'week' | 'done'
type Group = 'now' | 'next' | 'later'
const STATUSES = ['inbox', 'todo', 'in_progress', 'completed', 'cancelled']
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

/** Now: late, due today or started. Next: due this week, or urgent/high without a date. Later: everything else. */
function groupOf(task: RecordItem, now = Date.now()): Group {
  const due = task.due_at ? Date.parse(task.due_at) : null
  const endOfToday = new Date(now); endOfToday.setHours(23, 59, 59, 999)
  if (task.status === 'in_progress' || (due !== null && due <= endOfToday.getTime())) return 'now'
  if ((due !== null && due <= now + 7 * 86400000) || (due === null && (task.priority === 'urgent' || task.priority === 'high'))) return 'next'
  return 'later'
}

/**
 * Tasks (V20): tap and do. Tasks are grouped into Now, Next and Later; one tap completes (with undo), one tap starts
 * focus, a swipe does either on a phone. Details open in place; filters are chips; everything else is under "More".
 */
export default function TasksPage() {
  const t = useText(), { language } = useLanguage(), label = useStatusLabel(), toast = useToast(), focus = useStartFocus()
  const [params] = useSearchParams()
  const [filter, setFilter] = useState<Filter>(() => (['overdue', 'today', 'week'].includes(params.get('due') ?? '') ? params.get('due') as Filter : 'open'))
  const [search, setSearch] = useState(''), [searching, setSearching] = useState(false), [view, setView] = useState<'list' | 'board'>('list'), [moreOpen, setMoreOpen] = useState(false)
  const [priority, setPriority] = useState(''), [quick, setQuick] = useState(''), [open, setOpen] = useState<number | null>(null)
  const [editing, setEditing] = useState<Partial<RecordItem> | null>(null), [deleting, setDeleting] = useState<RecordItem | null>(null), [done, setDone] = useState<number[]>([]), [busy, setBusy] = useState(false)
  const query = filter === 'done' ? 'status=completed&sort=updated_at' : `due=${filter === 'open' ? 'open' : filter}&sort=priority`
  const data = useRecords('tasks', `per_page=100&${query}&search=${encodeURIComponent(search)}&priority=${priority}`)
  const reloadTasks = data.reload
  useEffect(() => { const reload = () => void reloadTasks(); window.addEventListener(TASKS_CHANGED, reload); return () => window.removeEventListener(TASKS_CHANGED, reload) }, [reloadTasks])

  async function run(fn: () => Promise<unknown>, success?: string) {
    setBusy(true)
    try { await fn(); await data.reload(); if (success) toast(success) } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }
  async function complete(task: RecordItem) {
    setDone(d => [...d, task.id])
    try {
      // Offline, the completion is kept on this device and the row stays ticked until it is sent.
      if (await completeTaskOrQueue(task) === 'queued') { toast(t('Saved on this device. Send it from “Waiting to sync” when you’re online.', 'حُفظ على هذا الجهاز. أرسله من «بانتظار المزامنة» عند الاتصال.')); return }
      toast(t('Done. Nice work.', 'تم. أحسنت.'), 'success', { label: t('Undo', 'تراجع'), onClick: () => void run(() => api(`/api/tasks/${task.id}`, 'PATCH', { status: task.status === 'completed' ? 'todo' : task.status }), t('Restored.', 'أُعيدت.')) })
      window.setTimeout(() => { setDone(d => d.filter(x => x !== task.id)); void data.reload() }, 500)
    } catch (e) { setDone(d => d.filter(x => x !== task.id)); toast((e as Error).message, 'error') }
  }
  /** Move a task to another day, or clear its date, in one tap; Undo puts the old date back. */
  async function reschedule(task: RecordItem, when: When) {
    const before = task.due_at ?? null, next = dueFor(when)
    await run(() => api(`/api/tasks/${task.id}`, 'PATCH', { due_at: next }))
    const where = { today: t('today', 'اليوم'), tomorrow: t('tomorrow', 'غداً'), week: t('this week', 'هذا الأسبوع'), nextweek: t('next week', 'الأسبوع القادم'), none: t('no date', 'بلا موعد') }[when]
    toast(t(`“${task.title}” moved to ${where}.`, `نُقلت «${task.title}» إلى ${where}.`), 'success', { label: t('Undo', 'تراجع'), onClick: () => void run(() => api(`/api/tasks/${task.id}`, 'PATCH', { due_at: before }), t('Restored.', 'أُعيد.')) })
  }
  async function setTaskPriority(task: RecordItem, next: string) {
    if (task.priority === next) return
    const before = task.priority ?? 'medium'
    await run(() => api(`/api/tasks/${task.id}`, 'PATCH', { priority: next }))
    toast(t(`“${task.title}” is now ${label(next).toLowerCase()}.`, `أصبحت أولوية «${task.title}» ${label(next)}.`), 'success', { label: t('Undo', 'تراجع'), onClick: () => void run(() => api(`/api/tasks/${task.id}`, 'PATCH', { priority: before }), t('Restored.', 'أُعيد.')) })
  }
  async function addQuick(e: FormEvent) {
    e.preventDefault()
    if (!quick.trim()) return
    await run(() => api('/api/tasks', 'POST', { title: quick.trim(), status: 'todo', priority: 'medium' }), t('Task added.', 'أُضيفت المهمة.'))
    setQuick('')
  }

  const items = data.items.filter(i => filter === 'done' || !['completed', 'cancelled'].includes(String(i.status)) || done.includes(i.id))
  // Changing the filter, search or priority re-reads the list; say how many tasks it now shows (not on first load).
  const listKey = `${query}|${search}|${priority}`, announced = useRef(listKey), count = items.length
  useEffect(() => {
    if (data.loading || announced.current === listKey) return
    announced.current = listKey
    announce(t(`${count} task(s)`, `${count} مهمة`))
  }, [data.loading, listKey, count, t])
  const groups: [Group, string][] = [['now', t('Now', 'الآن')], ['next', t('Next', 'التالي')], ['later', t('Later', 'لاحقاً')]]
  const byGroup = (g: Group) => items.filter(i => groupOf(i) === g).sort((a, b) => (PRIORITY_RANK[a.priority ?? 'medium'] ?? 2) - (PRIORITY_RANK[b.priority ?? 'medium'] ?? 2) || (a.due_at ?? '9').localeCompare(b.due_at ?? '9'))
  const filters: [Filter, string][] = [['open', t('All open', 'كل المفتوحة')], ['overdue', t('Late', 'متأخرة')], ['today', t('Today', 'اليوم')], ['week', t('7 days', '٧ أيام')], ['done', t('Done', 'منجزة')]]

  const row = (task: RecordItem) => <TaskRow key={task.id} task={task} done={done.includes(task.id) || task.status === 'completed'} expanded={open === task.id}
    onToggle={() => setOpen(open === task.id ? null : task.id)} onComplete={() => void complete(task)} onFocus={() => void focus.go(task.id)}
    onEdit={() => setEditing(task)} onDelete={() => setDeleting(task)} onReschedule={when => void reschedule(task, when)} onPriority={p => void setTaskPriority(task, p)} statusLabel={label} language={language} />

  return <section className="page tasks-page">
    <PageHead title={t('Tasks', 'المهام')} icon={CheckSquare} action={<>
      <button className="icon-button" aria-pressed={searching} aria-label={t('Search tasks', 'البحث في المهام')} onClick={() => { setSearching(v => !v); if (searching) setSearch('') }}><Search size={19} /></button>
      <button className="primary" onClick={openQuickAdd}><Plus size={18} /><span className="phone-sr">{t('Add task', 'إضافة مهمة')}</span></button>
    </>} />
    {searching && <input autoFocus className="task-search" type="search" value={search} onChange={e => setSearch(e.target.value)} aria-label={t('Search', 'بحث')} placeholder={t('Search tasks…', 'ابحث في المهام…')} />}
    <SwipeTip />
    <form className="inline-add" onSubmit={e => void addQuick(e)}><Plus size={18} aria-hidden="true" /><input value={quick} onChange={e => setQuick(e.target.value)} maxLength={200} aria-label={t('New task', 'مهمة جديدة')} placeholder={t('Add a task and press Enter', 'أضف مهمة واضغط Enter')} /></form>
    <div className="tasks-filters">
      <div className="chip-row" role="radiogroup" aria-label={t('Show', 'عرض')}>{filters.map(([key, name]) => <button key={key} type="button" role="radio" aria-checked={filter === key} className="filter-chip" onClick={() => setFilter(key)}>{name}</button>)}</div>
      <button type="button" className="icon-button" aria-expanded={moreOpen} aria-label={t('More options', 'خيارات أخرى')} onClick={() => setMoreOpen(v => !v)}><SlidersHorizontal size={18} /></button>
    </div>
    {moreOpen && <div className="tasks-more panel">
      <label>{t('Priority', 'الأولوية')}<select value={priority} onChange={e => setPriority(e.target.value)}><option value="">{t('Any', 'أي')}</option>{['urgent', 'high', 'medium', 'low'].map(p => <option key={p} value={p}>{label(p)}</option>)}</select></label>
      <div className="segmented" role="radiogroup" aria-label={t('Layout', 'التخطيط')}><button role="radio" aria-checked={view === 'list'} className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><List size={15} />{t('List', 'قائمة')}</button><button role="radio" aria-checked={view === 'board'} className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}><Columns3 size={15} />{t('Board', 'لوحة')}</button></div>
    </div>}
    <ErrorMessage error={data.error} />
    {data.loading && data.items.length === 0 ? <section className="panel"><Skeleton lines={5} /></section>
      : view === 'board' ? <Board items={data.items} label={label} onMove={(task, status) => void run(() => api(`/api/tasks/${task.id}`, 'PATCH', { status }))} onEdit={setEditing} />
        : items.length === 0 ? <EmptyNote icon={ListChecks} text={search || priority || filter !== 'open' ? t('Nothing matches.', 'لا نتائج.') : t('No open tasks.', 'لا مهام مفتوحة.')} action={<button className="quiet" onClick={openQuickAdd}><Plus size={16} />{t('Add', 'أضف')}</button>} />
          : filter === 'done' ? <section className="panel task-group"><ul className="task-list">{items.map(row)}</ul></section>
            : groups.map(([g, name]) => { const list = byGroup(g); return list.length === 0 ? null : <section key={g} className={`panel task-group group-${g}`} aria-labelledby={`group-${g}`}>
              <h2 id={`group-${g}`}><span className={`group-dot dot-${g}`} aria-hidden="true" />{name}<span className="group-count">{list.length}</span></h2>
              <ul className="task-list"><AnimatePresence initial={false}>{list.map(row)}</AnimatePresence></ul>
            </section> })}
    {data.lastPage > 1 && <p className="muted small">{t('Showing the first 100. Narrow with a filter or search.', 'تُعرض أول ١٠٠. ضيّق النتائج بفلتر أو بحث.')}</p>}
    <ConnectedTasksPanel onCopied={() => void data.reload()} />
    {editing && <RecordForm resource="tasks" item={editing} onSave={() => void data.reload()} onClose={() => setEditing(null)} />}
    {deleting && <Dialog title={t('Delete this task?', 'حذف هذه المهمة؟')} onClose={() => setDeleting(null)}><p>{deleting.title}</p><div className="toolbar"><button className="quiet" onClick={() => setDeleting(null)}>{t('Cancel', 'إلغاء')}</button><button className="danger" disabled={busy} onClick={() => void run(async () => { await api(`/api/tasks/${deleting.id}`, 'DELETE'); setDeleting(null) }, t('Deleted.', 'حُذفت.'))}><Trash2 size={15} />{t('Delete', 'حذف')}</button></div></Dialog>}
  </section>
}

/**
 * One task: tick to complete, play to focus, tap the title for details. On touch screens, swipe toward the end to
 * complete and toward the start to focus; the buttons do the same for everyone else.
 */
function TaskRow({ task, done, expanded, onToggle, onComplete, onFocus, onEdit, onDelete, onReschedule, onPriority, statusLabel, language }: { task: RecordItem; done: boolean; expanded: boolean; onToggle: () => void; onComplete: () => void; onFocus: () => void; onEdit: () => void; onDelete: () => void; onReschedule: (when: When) => void; onPriority: (priority: string) => void; statusLabel: (s: string) => string; language: string }) {
  const t = useText(), rtl = language === 'ar'
  const [dx, setDx] = useState(0)
  const start = useRef<{ x: number; y: number; id: number } | null>(null)
  // Words and icons, not only colour: what the swipe will do, and when letting go would do it (past 80px).
  const forward = rtl ? -dx : dx
  const mode: 'complete' | 'focus' | '' = forward > 24 && !done ? 'complete' : forward < -24 ? 'focus' : ''
  const ready = Math.abs(forward) > 80 && (mode === 'focus' || mode === 'complete')
  const subtasks = (task.subtasks as { title: string; completed: boolean }[] | undefined) ?? []
  function down(e: ReactPointerEvent) { if (e.pointerType !== 'touch') return; start.current = { x: e.clientX, y: e.clientY, id: e.pointerId } }
  function move(e: ReactPointerEvent) {
    const s = start.current
    if (!s || e.pointerId !== s.id) return
    const x = e.clientX - s.x
    if (Math.abs(e.clientY - s.y) > Math.abs(x)) { start.current = null; setDx(0); return }
    setDx(Math.max(-120, Math.min(120, x)))
  }
  function up() {
    const forward = rtl ? -dx : dx
    if (forward > 80 && !done) onComplete()
    else if (forward < -80) onFocus()
    start.current = null; setDx(0)
  }
  return <m.li layout exit={{ opacity: 0, height: 0 }} className={`task-item swipeable ${done ? 'is-done' : ''} ${expanded ? 'expanded' : ''}`}>
    <span className={`swipe-hint ${mode} ${ready ? 'ready' : ''}`} aria-hidden="true">
      {mode === 'complete' && <span className="swipe-label start"><Check size={16} />{ready ? t('Release', 'اترك') : t('Complete', 'إنجاز')}</span>}
      {mode === 'focus' && <span className="swipe-label end"><Play size={16} />{ready ? t('Release', 'اترك') : t('Focus', 'تركيز')}</span>}
    </span>
    <div className={`task-line${dx ? ' dragging' : ''}`} style={{ transform: dx ? `translateX(${dx}px)` : undefined }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { start.current = null; setDx(0) }}>
      <button type="button" className="tick" disabled={done} onClick={onComplete} aria-label={t(`Complete “${task.title}”`, `إنجاز «${task.title}»`)}><CheckIcon /></button>
      <button type="button" className="task-body text-button" aria-expanded={expanded} onClick={onToggle}>
        <strong>{task.title}</strong>
        <span className="meta-row"><PriorityMark priority={task.priority} /><DueChip due={task.due_at} done={done} />{task.estimated_minutes ? <span><Timer size={12} aria-hidden="true" />{task.estimated_minutes}′</span> : null}{subtasks.length > 0 && <span><ListChecks size={12} aria-hidden="true" />{subtasks.filter(s => s.completed).length}/{subtasks.length}</span>}{typeof task.remind_at === 'string' && <span title={t('Reminder', 'تذكير')}><Bell size={12} aria-hidden="true" /></span>}{task.status === 'in_progress' && <span className="chip">{statusLabel('in_progress')}</span>}</span>
      </button>
      {!done && <button type="button" className="icon-button play" onClick={onFocus} aria-label={t(`Focus on “${task.title}”`, `ركّز على «${task.title}»`)}><Play size={17} /></button>}
      <ChevronDown size={16} className={`task-chev ${expanded ? 'open' : ''}`} aria-hidden="true" />
    </div>
    {expanded && <div className="task-details">
      {task.notes ? <p>{String(task.notes)}</p> : null}
      {subtasks.length > 0 && <ul className="subtask-list">{subtasks.map((s, i) => <li key={i} className={s.completed ? 'done' : ''}>{s.completed ? '✓' : '○'} {s.title}</li>)}</ul>}
      {!done && <>
        <div className="task-quick" role="group" aria-label={t('Move to', 'نقل إلى')}>
          <span className="muted small">{t('Move to', 'نقل إلى')}</span>
          {([['today', t('Today', 'اليوم')], ['tomorrow', t('Tomorrow', 'غداً')], ['nextweek', t('Next week', 'الأسبوع القادم')], ['none', t('No date', 'بلا موعد')]] as [When, string][])
            .map(([when, name]) => <button key={when} type="button" className="filter-chip" onClick={() => onReschedule(when)}>{name}</button>)}
        </div>
        <div className="task-quick" role="radiogroup" data-arrow-select="false" aria-label={t('Priority', 'الأولوية')}>
          <span className="muted small">{t('Priority', 'الأولوية')}</span>
          {['urgent', 'high', 'medium', 'low'].map(p => <button key={p} type="button" role="radio" aria-checked={(task.priority ?? 'medium') === p} className="filter-chip" onClick={() => onPriority(p)}>{statusLabel(p)}</button>)}
        </div>
      </>}
      <div className="toolbar"><span className="muted small">{statusLabel(String(task.status))}</span><button className="quiet" onClick={onEdit}><Pencil size={15} />{t('Edit', 'تعديل')}</button><button className="quiet danger-text" onClick={onDelete}><Trash2 size={15} />{t('Delete', 'حذف')}</button></div>
    </div>}
  </m.li>
}

const CheckIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>

/** Simple board by status; drag a card to another column (keyboard: edit the task to change status). */
function Board({ items, label, onMove, onEdit }: { items: RecordItem[]; label: (s: string) => string; onMove: (task: RecordItem, status: string) => void; onEdit: (task: RecordItem) => void }) {
  const [dragging, setDragging] = useState<number | null>(null)
  return <div className="kanban">{STATUSES.map(s => <section key={s} className={dragging ? 'drop-ready' : ''} aria-label={label(s)}
    onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
    onDrop={e => { e.preventDefault(); const id = Number(e.dataTransfer.getData('text/plain')); setDragging(null); const task = items.find(i => i.id === id); if (task && task.status !== s) onMove(task, s) }}>
    <h3>{label(s)} <span className="muted">{items.filter(i => i.status === s).length}</span></h3>
    {items.filter(i => i.status === s).map(task => <article key={task.id} className="board-card" draggable onDragStart={e => { e.dataTransfer.setData('text/plain', String(task.id)); setDragging(task.id) }} onDragEnd={() => setDragging(null)}>
      <button className="text-button" onClick={() => onEdit(task)}><strong>{task.title}</strong></button>
      <span className="meta-row"><PriorityMark priority={task.priority} /><DueChip due={task.due_at} done={s === 'completed'} /></span>
    </article>)}
  </section>)}</div>
}


const SWIPE_TIP = 'lifeos-swipe-tip'
/** Said once on touch screens: the swipe exists, and the buttons on every row do the same. Dismissed for good with one tap. */
function SwipeTip() {
  const t = useText()
  const [shown, setShown] = useState(() => {
    try { return !!window.matchMedia?.('(pointer: coarse)').matches && localStorage.getItem(SWIPE_TIP) !== '1' } catch { return false }
  })
  if (!shown) return null
  return <p className="swipe-tip muted small" role="note">
    <span>{t('Tip: swipe a task toward the end to complete it, toward the start to focus. The ✓ and ▶ buttons do the same.', 'نصيحة: اسحب المهمة نحو النهاية لإنجازها، ونحو البداية للتركيز. زرّا ✓ و▶ يفعلان الشيء نفسه.')}</span>
    <button type="button" className="quiet" onClick={() => { try { localStorage.setItem(SWIPE_TIP, '1') } catch { /* asked again next time */ } setShown(false) }}>{t('Got it', 'فهمت')}</button>
  </p>
}
