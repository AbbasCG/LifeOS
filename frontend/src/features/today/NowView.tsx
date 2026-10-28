import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { AnimatePresence, m } from 'motion/react'
import { ArrowRight, Check, CheckCircle2, Clock, Coffee, Play, Plus, Sparkles, Timer } from 'lucide-react'
import type { Briefing, TodayData } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { useApi } from '../../lib/useApi'
import { useStartFocus } from '../../lib/useStartFocus'
import { minutesLabel } from '../../lib/dates'
import { isValidZone } from '../../lib/dial'
import { DueChip, EmptyNote, KindIcon, PriorityMark, ProgressRing, RingStat } from '../../components/visual'
import { openQuickAdd } from '../../lib/quickAdd'
import { completeTaskOrQueue } from '../../lib/offline'
import { Skeleton } from '../../components/ui/Shared'
import { RecommendationCard } from '../intelligence/RecommendationCard'
import type { Recommendation } from '../../lib/intelligence'

type Task = Briefing['focus'][number]
type Event = TodayData['timeline'][number]

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), intervalMs); return () => window.clearInterval(id) }, [intervalMs])
  return now
}

/**
 * The one thing to do now: what is happening (a running calendar item) or the top-ranked task, with one big action.
 * Below it, what comes next.
 */
export function NowCard({ briefing, today, onDone }: { briefing: Briefing | null; today: TodayData | null; onDone: () => void }) {
  const t = useText(), { language } = useLanguage(), now = useNow(), focus = useStartFocus(), toast = useToast()
  const [completing, setCompleting] = useState(false)
  if (!briefing || !today) return <section className="now-card"><Skeleton height={150} /></section>
  const zone = today.timezone && isValidZone(today.timezone) ? today.timezone : undefined
  const time = (iso: string) => new Date(iso).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', timeZone: zone })
  const events = today.timeline.filter(e => !e.all_day)
  const current = events.find(e => Date.parse(e.starts_at) <= now && Date.parse(e.ends_at) > now)
  const next = events.find(e => Date.parse(e.starts_at) > now)
  const task: Task | undefined = briefing.focus[0]
  const minsUntil = next ? Math.max(1, Math.round((Date.parse(next.starts_at) - now) / 60000)) : 0
  const linkedTask = current ? briefing.agenda.find(a => String(a.id) === current.id)?.task_id : null
  async function complete(item: { id: number; title: string }) {
    setCompleting(true)
    try { if (await completeTaskOrQueue(item) === 'queued') toast(t('Saved on this device. Send it from “Waiting to sync” when you’re online.', 'حُفظ على هذا الجهاز. أرسله من «بانتظار المزامنة» عند الاتصال.')); onDone() } catch (e) { toast((e as Error).message, 'error') } finally { setCompleting(false) }
  }
  const progress = today.progress.overall

  return <section className="now-card" aria-labelledby="now-title">
    <div className="now-main">
      {current ? <>
        <p className="now-eyebrow live"><span className="pulse" aria-hidden="true" />{t('Now', 'الآن')} · {time(current.starts_at)}–{time(current.ends_at)}</p>
        <h2 id="now-title" className="now-title"><KindIcon kind={current.kind} source={current.source} size={22} />{current.title}</h2>
        <div className="meta-row"><span><Clock size={13} aria-hidden="true" />{t(`${Math.max(1, Math.round((Date.parse(current.ends_at) - now) / 60000))} min left`, `متبقٍ ${Math.max(1, Math.round((Date.parse(current.ends_at) - now) / 60000))} د`)}</span></div>
        <div className="now-actions">
          <button className="cta" disabled={focus.busy} onClick={() => void focus.go(linkedTask ?? task?.id)}><Play size={20} />{t('Start focus', 'ابدأ التركيز')}</button>
          <Link className="quiet" to="/calendar">{t('Calendar', 'التقويم')}</Link>
        </div>
      </> : task ? <>
        <p className="now-eyebrow">{t('Do now', 'ابدأ الآن')}</p>
        <h2 id="now-title" className="now-title">{task.title}</h2>
        <div className="meta-row"><PriorityMark priority={task.priority} labelled /><DueChip due={task.due_at} /><span><Timer size={13} aria-hidden="true" />{minutesLabel(task.estimated_minutes, language === 'ar')}</span></div>
        <div className="now-actions">
          <button className="cta" disabled={focus.busy} onClick={() => void focus.go(task.id)}><Play size={20} />{t('Start focus', 'ابدأ التركيز')}</button>
          <button className="quiet" disabled={completing} onClick={() => void complete(task)} aria-label={t(`Mark “${task.title}” done`, `إنجاز «${task.title}»`)}><Check size={18} />{t('Done', 'تم')}</button>
          <Link className="quiet hide-phone" to="/today/plan"><Sparkles size={16} />{t('Plan my day', 'خطط يومي')}</Link>
        </div>
      </> : <>
        <p className="now-eyebrow">{t('All clear', 'لا شيء عاجل')}</p>
        <h2 id="now-title" className="now-title">{t('Nothing urgent right now', 'لا شيء عاجل الآن')}</h2>
        <div className="now-actions">
          <button className="cta" onClick={openQuickAdd}><Plus size={20} />{t('Add a task', 'أضف مهمة')}</button>
          <button className="quiet" disabled={focus.busy} onClick={() => void focus.go(null)}><Play size={16} />{t('Free focus', 'تركيز حر')}</button>
        </div>
      </>}
    </div>
    <div className="now-side">
      <ProgressRing value={progress} max={100} size={92} stroke={9} tone={progress >= 75 ? 'success' : 'primary'} label={t(`Today ${progress}% done`, `أُنجز ${progress}٪ من اليوم`)}><strong>{progress}%</strong><small>{t('today', 'اليوم')}</small></ProgressRing>
    </div>
    {next && <Link to="/calendar" className="now-next">
      <span className="now-next-label">{t('Next', 'التالي')}</span>
      <KindIcon kind={next.kind} source={next.source} />
      <strong>{next.title}</strong>
      <time>{time(next.starts_at)}</time>
      <span className="muted">{minsUntil < 60 ? t(`in ${minsUntil} min`, `بعد ${minsUntil} د`) : t(`in ${minutesLabel(minsUntil, false)}`, `بعد ${minutesLabel(minsUntil, true)}`)}</span>
      <ArrowRight size={15} className="flip-rtl" aria-hidden="true" />
    </Link>}
  </section>
}

/**
 * Today on one line: the working day as a bar with every commitment as a colored block (icon + title on hover and for
 * screen readers), free focus time, and where "now" is. Plus how full the day is.
 */
export function TodayStrip({ today }: { today: TodayData | null }) {
  const t = useText(), { language } = useLanguage(), now = useNow(60_000)
  if (!today) return <section className="panel today-strip"><Skeleton height={64} /></section>
  const zone = today.timezone && isValidZone(today.timezone) ? today.timezone : undefined
  const time = (iso: string | number) => new Date(iso).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', timeZone: zone })
  const events = today.timeline.filter(e => !e.all_day)
  const dayStart = today.day_start ? Date.parse(today.day_start) : new Date().setHours(0, 0, 0, 0)
  // Show from the earliest of 08:00 / first item to the latest of 20:00 / last item, in whole hours.
  const hour = 3_600_000
  const from = Math.min(dayStart + 8 * hour, ...events.map(e => Date.parse(e.starts_at)))
  const to = Math.max(dayStart + 20 * hour, ...events.map(e => Date.parse(e.ends_at)))
  const start = Math.floor((from - dayStart) / hour) * hour + dayStart, end = Math.ceil((to - dayStart) / hour) * hour + dayStart
  const pos = (ms: number) => `${Math.max(0, Math.min(100, (ms - start) / (end - start) * 100))}%`
  const width = (a: number, b: number) => `${Math.max(0.8, (Math.min(b, end) - Math.max(a, start)) / (end - start) * 100)}%`
  const hours = Array.from({ length: (end - start) / hour + 1 }, (_, i) => start + i * hour).filter((_, i, all) => all.length <= 9 || i % 2 === 0)
  const load = today.energy.load_percent
  const remaining = events.filter(e => Date.parse(e.ends_at) > now)
  const tone = (e: Event) => e.source !== 'lifeos' ? 'external' : e.kind === 'fixed' ? 'meeting' : 'focus'

  return <section className="panel today-strip" aria-labelledby="strip-title">
    <header className="strip-head">
      <h2 id="strip-title">{t('Today', 'اليوم')}</h2>
      <span className="strip-stat"><ProgressRing value={Math.min(load, 100)} size={30} stroke={4} tone={load >= 90 ? 'danger' : load >= 60 ? 'warning' : 'success'} label={t(`Day ${load}% booked`, `اليوم محجوز ${load}٪`)} /><span>{t(`${load}% booked`, `${load}٪ محجوز`)}</span></span>
      <span className="strip-stat"><Coffee size={16} aria-hidden="true" /><span>{t(`${minutesLabel(today.focus_time.free_minutes, false)} free`, `${minutesLabel(today.focus_time.free_minutes, true)} متاحة`)}</span></span>
      <Link className="icon-button strip-open" to="/calendar" aria-label={t('Open calendar', 'فتح التقويم')}><ArrowRight size={18} className="flip-rtl" /></Link>
    </header>
    <div className="strip" role="group" aria-label={t('Today’s schedule', 'جدول اليوم')}>
      {today.focus_time.slots.map(s => <span key={s.starts_at} className="strip-free" style={{ insetInlineStart: pos(Date.parse(s.starts_at)), width: width(Date.parse(s.starts_at), Date.parse(s.ends_at)) }} aria-hidden="true" />)}
      {events.map(e => <Link key={e.id} to="/calendar" className={`strip-block tone-${tone(e)} ${Date.parse(e.ends_at) <= now ? 'past' : ''}`} style={{ insetInlineStart: pos(Date.parse(e.starts_at)), width: width(Date.parse(e.starts_at), Date.parse(e.ends_at)) }}
        aria-label={`${e.title}, ${time(e.starts_at)}–${time(e.ends_at)}`} title={`${time(e.starts_at)} ${e.title}`}><KindIcon kind={e.kind} source={e.source} size={12} /></Link>)}
      {now >= start && now <= end && <span className="strip-now" style={{ insetInlineStart: pos(now) }} aria-hidden="true"><i /></span>}
    </div>
    <div className="strip-hours" aria-hidden="true">{hours.map(h => <span key={h} style={{ insetInlineStart: pos(h) }}>{new Date(h).toLocaleTimeString(language, { hour: 'numeric', timeZone: zone })}</span>)}</div>
    {remaining.length === 0 && events.length > 0 && <p className="muted small strip-note"><CheckCircle2 size={14} aria-hidden="true" />{t('Nothing left on the calendar today.', 'لا شيء متبقٍ في تقويم اليوم.')}</p>}
  </section>
}

/** The top three ranked tasks: one tap to finish, one tap to focus. */
export function TopThree({ briefing, onChange }: { briefing: Briefing | null; onChange: () => void }) {
  const t = useText(), focus = useStartFocus(), toast = useToast()
  const [done, setDone] = useState<number[]>([]), [busy, setBusy] = useState<number | null>(null)
  if (!briefing) return <section className="panel top-three"><Skeleton lines={3} /></section>
  const items = briefing.focus.slice(0, 3)
  async function complete(task: Task) {
    setBusy(task.id); setDone(d => [...d, task.id])
    try { const result = await completeTaskOrQueue(task); toast(result === 'queued' ? t('Saved on this device. Send it from “Waiting to sync” when you’re online.', 'حُفظ على هذا الجهاز. أرسله من «بانتظار المزامنة» عند الاتصال.') : t('Done. Nice work.', 'تم. أحسنت.')); if (result === 'done') window.setTimeout(onChange, 450) }
    catch (e) { setDone(d => d.filter(x => x !== task.id)); toast((e as Error).message, 'error') } finally { setBusy(null) }
  }
  return <section className="panel top-three" aria-labelledby="top-title">
    <header className="row"><h2 id="top-title">{t('Top 3', 'أهم ٣')}</h2><Link to="/tasks" className="icon-button" aria-label={t('All tasks', 'كل المهام')}><ArrowRight size={18} className="flip-rtl" /></Link></header>
    {items.length === 0 ? <EmptyNote icon={CheckCircle2} text={t('No open tasks.', 'لا مهام مفتوحة.')} action={<button className="quiet" onClick={openQuickAdd}><Plus size={16} />{t('Add', 'أضف')}</button>} />
      : <ul className="task-list compact"><AnimatePresence initial={false}>{items.map(task => <m.li key={task.id} layout exit={{ opacity: 0, height: 0 }} className={`task-item ${done.includes(task.id) ? 'is-done' : ''}`}>
        <button type="button" className="tick" disabled={busy === task.id || done.includes(task.id)} onClick={() => void complete(task)} aria-label={t(`Complete “${task.title}”`, `إنجاز «${task.title}»`)}><Check size={16} /></button>
        <div className="task-body"><strong>{task.title}</strong><div className="meta-row"><PriorityMark priority={task.priority} /><DueChip due={task.due_at} /><span><Timer size={12} aria-hidden="true" />{task.estimated_minutes}′</span></div></div>
        <button type="button" className="icon-button play" disabled={focus.busy} onClick={() => void focus.go(task.id)} aria-label={t(`Focus on “${task.title}”`, `ركّز على «${task.title}»`)}><Play size={17} /></button>
      </m.li>)}</AnimatePresence></ul>}
  </section>
}

/** Progress at a glance: tasks, focus and habits as rings. */
export function ProgressRow({ today }: { today: TodayData | null }) {
  const t = useText(), { language } = useLanguage()
  if (!today) return <section className="panel progress-row"><Skeleton height={80} /></section>
  const p = today.progress
  return <section className="panel progress-row" aria-label={t('Progress today', 'تقدم اليوم')}>
    <RingStat value={p.tasks.done} max={Math.max(1, p.tasks.target)} display={`${p.tasks.done}/${p.tasks.target}`} caption={t('Tasks', 'المهام')} tone="primary" to="/tasks" />
    <RingStat value={p.focus.done} max={Math.max(1, p.focus.target)} display={minutesLabel(p.focus.done, language === 'ar')} caption={t('Focus', 'التركيز')} tone="accent" to="/focus" />
    <RingStat value={p.habits.done} max={Math.max(1, p.habits.target)} display={`${p.habits.done}/${p.habits.target}`} caption={t('Habits', 'العادات')} tone="success" to="/habits" />
  </section>
}

/** One suggestion from Copilot, compact; the rest one tap away. */
export function CopilotPick() {
  const t = useText()
  const { data, reload } = useApi<{ enabled: boolean; data: Recommendation[] }>('/api/recommendations')
  const [gone, setGone] = useState<number[]>([])
  if (!data?.enabled) return null
  const recs = data.data.filter(r => !gone.includes(r.id))
  if (recs.length === 0) return null
  return <section className="copilot-pick" aria-labelledby="pick-title">
    <header className="row"><h2 id="pick-title"><Sparkles size={17} aria-hidden="true" />{t('Copilot suggests', 'يقترح المساعد')}</h2>{recs.length > 1 && <span className="muted small">{t(`+${recs.length - 1} more below`, `+${recs.length - 1} أخرى بالأسفل`)}</span>}</header>
    <ul className="rec-list"><RecommendationCard rec={recs[0]} onChange={(id, isGone) => { if (isGone) setGone(g => [...g, id]); else reload() }} /></ul>
  </section>
}
