import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams, Link } from 'react-router'
import { Play, Pause, Square, X, BellRing, BellOff, Coffee, Brain, Timer, PenLine, Zap, Flame, Target, AlertTriangle, CheckCircle2, Clock, Maximize2, Minimize2, Orbit, Focus, SlidersHorizontal, BarChart3, History } from 'lucide-react'
import { Expandable, PageHead } from '../components/visual'
import { AnimatePresence, m } from 'motion/react'
import { LivingOrb } from '../components/orb/LivingOrb'
import { api, type Page } from '../lib/api'
import { useRecords } from '../lib/hooks'
import { useApi } from '../lib/useApi'
import { useText } from '../lib/i18n'
import { useLanguage } from '../contexts/LanguageContext'
import { useToast } from '../lib/toast'
import { ErrorMessage, Skeleton } from '../components/ui/Shared'
import { clock, DEEP_MINUTES, elapsedNow, newClientId, nextPomodoroStep, POMODORO, type FocusInsightsData, type FocusMode, type FocusSessionRecord, type SessionKind } from '../lib/focus'
import { notify as notifyUser } from '../lib/quickActions'

const DISTRACTIONS = ['phone', 'people', 'notifications', 'thought', 'other'] as const

export default function FocusPage() {
  const t = useText(), { language } = useLanguage(), toast = useToast(), [params] = useSearchParams()
  const [sessions, setSessions] = useState<FocusSessionRecord[] | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [now, setNow] = useState(() => Date.now())
  const [mode, setMode] = useState<FocusMode>('pomodoro'), [minutes, setMinutes] = useState(POMODORO.focus), [taskId, setTaskId] = useState(params.get('task') || ''), [projectId, setProjectId] = useState('')
  const [notes, setNotes] = useState(''), [distracting, setDistracting] = useState(false), [distractionNote, setDistractionNote] = useState('')
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
  const tasks = useRecords('tasks', 'per_page=100&due=open&sort=priority'), projects = useRecords('projects', 'per_page=100')
  const insights = useApi<FocusInsightsData>('/api/focus-sessions/insights?days=30')
  const pendingStart = useRef<string | null>(null), finishing = useRef<number | null>(null)

  const reload = useCallback(async () => {
    try { setSessions((await api<Page<FocusSessionRecord>>('/api/focus-sessions')).data) } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => {
    let alive = true
    api<Page<FocusSessionRecord>>('/api/focus-sessions').then(p => { if (alive) setSessions(p.data) }).catch(e => { if (alive) setError((e as Error).message) })
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => { alive = false; window.clearInterval(id) }
  }, [])

  const active = sessions?.find(s => s.status === 'running' || s.status === 'paused')
  const elapsed = active ? elapsedNow(active, now) : 0
  const remaining = active ? active.duration_seconds - elapsed : minutes * 60
  const lastFinished = sessions?.find(s => s.status === 'completed' || s.status === 'cancelled')
  const suggestion = !active ? nextPomodoroStep(lastFinished && now - new Date(lastFinished.completed_at ?? lastFinished.created_at).getTime() < 3 * 3600_000 ? lastFinished : undefined) : null
  const label = (kind: SessionKind, m: FocusMode | null) => kind === 'short_break' ? t('Short break', 'استراحة قصيرة') : kind === 'long_break' ? t('Long break', 'استراحة طويلة') : kind === 'manual' ? t('Logged time', 'وقت مسجّل') : m === 'deep' ? t('Deep work', 'عمل عميق') : m === 'pomodoro' ? t('Pomodoro', 'بومودورو') : t('Focus', 'تركيز')

  // Through the service worker where possible: Android needs it, and it adds one-tap buttons where the browser has them.
  const notify = useCallback((title: string, body: string, isBreak: boolean) => {
    void notifyUser(title, { body, tag: 'lifeos-focus', link: '/focus', actions: isBreak
      ? [{ action: 'focus-again', title: t('Focus again', 'تركيز مجدداً'), link: '/?focus=start' }]
      : [{ action: 'focus-break', title: t('Start break', 'ابدأ استراحة'), link: '/?focus=break' }, { action: 'focus-again', title: t('Focus again', 'تركيز مجدداً'), link: '/?focus=start' }] })
  }, [t])

  const act = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    if (!active) return
    setBusy(true); setError('')
    try {
      const updated = await api<FocusSessionRecord>(`/api/focus-sessions/${active.id}`, 'PATCH', { action, ...extra })
      setSessions(list => list?.map(s => s.id === updated.id ? updated : s) ?? null)
      if (updated.status === 'completed') { setNotes(''); insights.reload() }
      return updated
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }, [active, insights])

  // When the countdown reaches zero, finish once (guarded against repeated ticks) and alert the user.
  useEffect(() => {
    if (!active || active.status !== 'running' || remaining > 0 || finishing.current === active.id) return
    finishing.current = active.id
    const isBreak = active.kind !== 'focus'
    void act('finish', notes ? { notes } : {}).then(() => {
      notify(isBreak ? t('Break is over', 'انتهت الاستراحة') : t('Focus session complete', 'اكتملت جلسة التركيز'), isBreak ? t('Ready for the next round?', 'مستعد للجولة التالية؟') : t('Nice work. Take a short break.', 'عمل رائع. خذ استراحة قصيرة.'), isBreak)
      toast(isBreak ? t('Break finished.', 'انتهت الاستراحة.') : t('Session complete — time saved.', 'اكتملت الجلسة — حُفظ الوقت.'))
    })
  }, [active, remaining, act, notes, notify, toast, t])

  useEffect(() => {
    const base = document.title.replace(/^\d[\d:]* · /, '')
    document.title = active ? `${clock(remaining)} · ${base}` : base
    return () => { document.title = base }
  }, [active, remaining])

  async function start(kind: SessionKind, durationMinutes: number, cycle?: number) {
    setBusy(true); setError('')
    pendingStart.current ??= newClientId()
    const focusMode = kind === 'focus' ? (mode === 'manual' ? 'custom' : mode) : undefined
    try {
      await api<FocusSessionRecord>('/api/focus-sessions', 'POST', { kind, duration_seconds: Math.round(durationMinutes * 60), mode: focusMode, cycle: cycle ?? (kind === 'focus' && mode === 'pomodoro' ? (suggestion?.kind === 'focus' ? suggestion.cycle : 1) : undefined), task_id: taskId ? Number(taskId) : null, project_id: !taskId && projectId ? Number(projectId) : null, notes: kind === 'manual' && notes ? notes : undefined, client_id: pendingStart.current })
      pendingStart.current = null
      if (kind === 'manual') { toast(t('Time logged.', 'سُجّل الوقت.')); setNotes(''); insights.reload() }
      await reload(); finishing.current = null
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  function chooseMode(next: FocusMode) {
    setMode(next); setMinutes(next === 'pomodoro' ? POMODORO.focus : next === 'deep' ? DEEP_MINUTES : next === 'manual' ? 30 : 45)
  }
  async function logDistraction(reason: string) {
    const updated = await act('interrupt', { reason, note: distractionNote || null })
    if (updated) { setDistracting(false); setDistractionNote(''); toast(t('Distraction noted. Back to it.', 'سُجّلت المقاطعة. عُد إلى عملك.')) }
  }
  async function enableAlerts() {
    if (typeof Notification === 'undefined') return
    setPermission(await Notification.requestPermission())
  }

  // 3D ambience is optional and remembered per device; immersive mode hides everything but the session.
  const [ambience, setAmbience] = useState(() => { try { return localStorage.getItem('lifeos-focus-ambience') !== 'off' } catch { return true } })
  const [immersive, setImmersive] = useState(false)
  const toggleAmbience = () => setAmbience(on => { try { localStorage.setItem('lifeos-focus-ambience', on ? 'off' : 'on') } catch { /* storage unavailable */ } return !on })
  useEffect(() => {
    if (!immersive) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setImmersive(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [immersive])

  // Space toggles pause/resume when the user is not typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (e.code !== 'Space' || !active || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) || target.isContentEditable) return
      e.preventDefault(); void act(active.status === 'running' ? 'pause' : 'resume')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, act])

  const progress = active ? elapsed / active.duration_seconds : 0
  const orbMode = !active ? 'idle' : active.status !== 'running' ? 'paused' : active.kind === 'focus' ? 'focus' : 'idle'
  const orbLabel = active ? t(`Session ${Math.round(progress * 100)}% complete, ${clock(remaining)} left`, `الجلسة مكتملة بنسبة ${Math.round(progress * 100)}٪، متبقٍ ${clock(remaining)}`) : t('Focus orb, ready', 'كرة التركيز، جاهزة')
  const history = useMemo(() => (sessions ?? []).filter(s => s.status === 'completed' || s.status === 'cancelled').slice(0, 15), [sessions])
  const reason = (r: string) => ({ phone: t('Phone', 'الهاتف'), people: t('People', 'أشخاص'), notifications: t('Notifications', 'الإشعارات'), thought: t('Wandering thought', 'تشتت ذهني'), other: t('Other', 'أخرى') } as Record<string, string>)[r] ?? r
  const fmtTime = (iso: string) => new Date(iso).toLocaleString(language, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  const ins = insights.data

  return <section className="page focus-page">
    <PageHead title={t('Focus', 'التركيز')} icon={Focus} action={permission !== 'unsupported' && permission !== 'granted' ? <button className="icon-button" onClick={() => void enableAlerts()} disabled={permission === 'denied'} aria-label={permission === 'denied' ? t('Timer alerts are blocked in your browser settings', 'تنبيهات المؤقت محظورة في إعدادات المتصفح') : t('Enable timer alerts', 'تفعيل تنبيهات المؤقت')} title={permission === 'denied' ? t('Alerts blocked', 'التنبيهات محظورة') : t('Enable timer alerts', 'تفعيل تنبيهات المؤقت')}>{permission === 'denied' ? <BellOff size={19} /> : <BellRing size={19} />}</button> : undefined} />
    <ErrorMessage error={error} />
    <div className="focus-v5">
      <section className={`panel focus-stage${active ? ` is-${active.status}` : ''}${active && active.kind !== 'focus' ? ' is-break' : ''}`} aria-live="polite">
        {!active && <div className="segmented focus-modes" role="tablist" aria-label={t('Focus mode', 'نمط التركيز')}>
          {([['pomodoro', t('Pomodoro', 'بومودورو'), Timer], ['deep', t('Deep work', 'عمل عميق'), Brain], ['custom', t('Custom', 'مخصص'), Clock], ['manual', t('Log time', 'تسجيل وقت'), PenLine]] as const).map(([value, text, Icon]) =>
            <button key={value} role="tab" aria-selected={mode === value} className={mode === value ? 'active' : ''} onClick={() => chooseMode(value)}><Icon size={15} />{text}</button>)}
        </div>}
        <div className="focus-dial" style={{ ['--progress' as string]: String(progress) }}>
          {ambience && <LivingOrb className="dial-orb" progress={progress} mode={orbMode} size="74%" interactive={false} label={orbLabel} />}
          <svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="54" className="track" /><circle cx="60" cy="60" r="54" className="value" pathLength={100} strokeDasharray={`${progress * 100} 100`} /></svg>
          <div className="dial-center">
            <span className="dial-kind">{active ? label(active.kind, active.mode) : mode === 'manual' ? t('Log time', 'تسجيل وقت') : label('focus', mode)}{active?.cycle ? ` · ${t('round', 'الجولة')} ${active.cycle}` : ''}</span>
            <span className="dial-time" dir="ltr">{clock(remaining)}</span>
            <span className="dial-status">{active?.status === 'paused' ? t('Paused', 'متوقف مؤقتاً') : active ? (active.task?.title ?? active.project?.title ?? t('Stay present', 'ابقَ حاضراً')) : t('Ready when you are', 'جاهز عندما تكون جاهزاً')}</span>
          </div>
        </div>
        {active ? <>
          <div className="focus-controls">
            <button className="primary big" disabled={busy || remaining <= 0} onClick={() => void act(active.status === 'running' ? 'pause' : 'resume')} aria-keyshortcuts="Space">{active.status === 'running' ? <><Pause size={18} />{t('Pause', 'إيقاف مؤقت')}</> : <><Play size={18} />{t('Resume', 'استئناف')}</>}</button>
            <button className="quiet big" disabled={busy} onClick={() => void act('finish', notes ? { notes } : {})}><Square size={16} />{t('Finish & save', 'إنهاء وحفظ')}</button>
            <button className="quiet big" disabled={busy} onClick={() => void act('cancel')} aria-label={t('Discard session', 'تجاهل الجلسة')}><X size={16} /></button>
          </div>
          {active.kind === 'focus' && <div className="focus-extras">
            {!distracting ? <button className="text-link" onClick={() => setDistracting(true)}><AlertTriangle size={14} />{t('Log a distraction', 'تسجيل مقاطعة')}{active.interruptions?.length ? ` (${active.interruptions.length})` : ''}</button>
              : <div className="distraction-picker" role="group" aria-label={t('What pulled you away?', 'ما الذي شتّتك؟')}>
                <input value={distractionNote} maxLength={200} onChange={e => setDistractionNote(e.target.value)} placeholder={t('Optional note', 'ملاحظة اختيارية')} aria-label={t('Distraction note', 'ملاحظة المقاطعة')} />
                <div className="chip-row">{DISTRACTIONS.map(d => <button key={d} className="chip-button" disabled={busy} onClick={() => void logDistraction(d)}>{reason(d)}</button>)}<button className="text-link" onClick={() => setDistracting(false)}>{t('Cancel', 'إلغاء')}</button></div>
              </div>}
            <Expandable className="session-notes-x" summary={notes ? t('Note added', 'أُضيفت ملاحظة') : t('Add a note', 'إضافة ملاحظة')} icon={<PenLine size={15} aria-hidden="true" />}><label className="session-notes">{t('Session notes', 'ملاحظات الجلسة')}<textarea rows={2} maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('What did you get done? Saved when you finish.', 'ماذا أنجزت؟ تُحفظ عند الإنهاء.')} /></label></Expandable>
          </div>}
          <div className="toolbar center">
            <button className="quiet" onClick={() => setImmersive(true)}><Maximize2 size={15} />{t('Immersive mode', 'وضع الانغماس')}</button>
            <button className="quiet" aria-pressed={ambience} onClick={toggleAmbience}><Orbit size={15} />{ambience ? t('3D ambience on', 'الأجواء ثلاثية الأبعاد مفعّلة') : t('3D ambience off', 'الأجواء ثلاثية الأبعاد متوقفة')}</button>
          </div>
        </> : <>
          {suggestion && <div className="next-step">
            {suggestion.kind === 'focus' ? <Zap size={16} /> : <Coffee size={16} />}
            <span>{suggestion.kind === 'focus' ? t(`Break done — ready for Pomodoro round ${suggestion.cycle}?`, `انتهت الاستراحة — مستعد لجولة البومودورو ${suggestion.cycle}؟`) : t(`Round ${suggestion.cycle} complete. Take a ${suggestion.minutes}-minute ${suggestion.kind === 'long_break' ? 'long ' : ''}break.`, `اكتملت الجولة ${suggestion.cycle}. خذ استراحة ${suggestion.minutes} دقائق.`)}</span>
            <button className="primary" disabled={busy} onClick={() => void start(suggestion.kind, suggestion.minutes, suggestion.cycle)}>{suggestion.kind === 'focus' ? t('Start round', 'بدء الجولة') : t('Start break', 'بدء الاستراحة')}</button>
          </div>}
          <div className="focus-controls">
            <button className="cta focus-start" disabled={busy || minutes < 1 || minutes > 240} onClick={() => void start(mode === 'manual' ? 'manual' : 'focus', minutes)}>{mode === 'manual' ? <><PenLine size={20} />{t('Save time', 'حفظ الوقت')}</> : <><Play size={22} />{mode === 'pomodoro' ? t(`Start ${POMODORO.focus} min`, `ابدأ ${POMODORO.focus} دقيقة`) : mode === 'deep' ? t(`Start ${DEEP_MINUTES} min deep work`, `ابدأ ${DEEP_MINUTES} دقيقة عمل عميق`) : t('Start focus', 'بدء التركيز')}</>}</button>
          </div>
          <label className="focus-task">{t('Task', 'المهمة')}<select value={taskId} onChange={e => setTaskId(e.target.value)}><option value="">{t('No task', 'بدون مهمة')}</option>{tasks.items.filter(v => v.status !== 'completed').map(v => <option key={v.id} value={v.id}>{v.title}</option>)}</select></label>
          <Expandable className="focus-options" summary={t('More options', 'خيارات أخرى')} icon={<SlidersHorizontal size={16} aria-hidden="true" />}>
            <div className="form-grid focus-setup">
              {(mode === 'custom' || mode === 'manual') && <label>{mode === 'manual' ? t('Minutes worked', 'الدقائق المنجزة') : t('Minutes', 'الدقائق')}<input type="number" min={1} max={240} value={minutes} onChange={e => setMinutes(Number(e.target.value))} /></label>}
              {!taskId && <label className={mode === 'custom' || mode === 'manual' ? '' : 'full'}>{t('Project', 'المشروع')}<select value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">{t('No project', 'بدون مشروع')}</option>{projects.items.filter(p => p.status !== 'completed').map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>}
              {mode === 'manual' && <label className="full">{t('Notes (optional)', 'ملاحظات (اختياري)')}<textarea rows={2} maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} /></label>}
            </div>
            {mode !== 'manual' && <div className="toolbar">
              <button className="quiet" disabled={busy} onClick={() => void start('short_break', POMODORO.short)}><Coffee size={16} />{t('5 min break', 'استراحة ٥ د')}</button>
              <button className="quiet" disabled={busy} onClick={() => void start('long_break', POMODORO.long)}><Coffee size={16} />{t('15 min break', 'استراحة ١٥ د')}</button>
            </div>}
          </Expandable>
        </>}
      </section>

      <aside className="focus-side">
        <Expandable defaultOpen={false} summary={<>{t('Last 30 days', 'آخر ٣٠ يوماً')}{ins && ins.sessions > 0 && <span className="summary-stat">{Math.round(ins.minutes / 6) / 10}{t('h', 'س')} · <Flame size={13} aria-hidden="true" />{ins.streak_days}</span>}</>} icon={<BarChart3 size={17} aria-hidden="true" />}>
          {!ins ? <Skeleton lines={3} /> : ins.sessions === 0 ? <p className="muted">{t('Finish a session to see your focus patterns.', 'أنهِ جلسة لترى أنماط تركيزك.')}</p> : <>
            <div className="focus-stats">
              <div><strong>{Math.round(ins.minutes / 6) / 10}{t('h', 'س')}</strong><span>{t('focused', 'تركيز')}</span></div>
              <div><strong><Flame size={15} />{ins.streak_days}</strong><span>{t('day streak', 'أيام متتالية')}</span></div>
              <div><strong>{ins.consistency}%</strong><span>{t('of days', 'من الأيام')}</span></div>
              <div><strong>{ins.completion_rate ?? '—'}{ins.completion_rate !== null ? '%' : ''}</strong><span>{t('finished', 'مكتملة')}</span></div>
            </div>
            <div className="mini-bars" role="img" aria-label={t('Focus minutes per day', 'دقائق التركيز يومياً')}>{ins.by_day.map(d => <span key={d.date} title={`${d.date}: ${d.minutes} min`} style={{ height: `${Math.max(4, Math.min(100, d.minutes / Math.max(1, ...ins.by_day.map(x => x.minutes)) * 100))}%` }} />)}</div>
            <ul className="focus-facts">
              <li><Brain size={14} />{t(`${Math.round(ins.deep_minutes / 6) / 10}h of deep work (50+ min sessions)`, `${Math.round(ins.deep_minutes / 6) / 10} س عمل عميق (جلسات ٥٠+ دقيقة)`)}</li>
              <li><AlertTriangle size={14} />{t(`${ins.interruptions_per_hour} distractions per focus hour`, `${ins.interruptions_per_hour} مقاطعة لكل ساعة تركيز`)}{ins.distractions[0] ? ` · ${reason(ins.distractions[0].reason)}` : ''}</li>
              {ins.best_hour !== null && <li><Target size={14} />{t(`Peak focus around ${String(ins.best_hour).padStart(2, '0')}:00`, `ذروة التركيز حوالي ${String(ins.best_hour).padStart(2, '0')}:00`)}</li>}
            </ul>
            {ins.tips.length > 0 && <ul className="finding-list">{ins.tips.map((tip, i) => <li key={i} className="finding-positive">{language === 'ar' ? tip.ar : tip.en}</li>)}</ul>}
          </>}
        </Expandable>
        <Expandable summary={<>{t('Session history', 'سجل الجلسات')}{history.length > 0 && <span className="summary-stat">{history.length}</span>}</>} icon={<History size={17} aria-hidden="true" />}>
          {sessions === null ? <Skeleton lines={3} /> : history.length === 0 ? <p className="muted">{t('Your sessions will appear here.', 'ستظهر جلساتك هنا.')}</p> :
            <ul className="session-history">{history.map(s => <li key={s.id} className={s.status}>
              <div className="row"><strong>{label(s.kind, s.mode)}</strong><span className="muted small">{fmtTime(s.completed_at ?? s.created_at)}</span></div>
              <div className="metadata">
                <span>{s.status === 'cancelled' ? t('Stopped early', 'توقفت مبكراً') : <><CheckCircle2 size={12} /> {Math.round(s.elapsed_seconds / 60)} {t('min', 'د')}</>}</span>
                {s.task && <Link to="/tasks">{s.task.title}</Link>}{!s.task && s.project && <span>{s.project.title}</span>}
                {!!s.interruptions?.length && <span>{t(`${s.interruptions.length} distraction(s)`, `${s.interruptions.length} مقاطعة`)}</span>}
              </div>
              {s.notes && <p className="muted small">{s.notes}</p>}
            </li>)}</ul>}
        </Expandable>
      </aside>
    </div>
  <AnimatePresence>{immersive && active && <m.div className="focus-immersive" role="dialog" aria-modal="true" aria-label={t('Immersive focus', 'تركيز منغمس')} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }}>
      <div className="immersive-inner">
        <LivingOrb progress={progress} mode={orbMode} size="min(52vh, 420px)" label={orbLabel} />
        <span className="timer" dir="ltr" aria-live="off">{clock(remaining)}</span>
        <p className="immersive-task">{active.status === 'paused' ? t('Paused', 'متوقف مؤقتاً') : active.task?.title ?? active.project?.title ?? t('Stay present', 'ابقَ حاضراً')}</p>
        <div className="toolbar center">
          <button className="primary big" disabled={busy || remaining <= 0} onClick={() => void act(active.status === 'running' ? 'pause' : 'resume')}>{active.status === 'running' ? <><Pause size={18} />{t('Pause', 'إيقاف مؤقت')}</> : <><Play size={18} />{t('Resume', 'استئناف')}</>}</button>
          <button className="quiet big" disabled={busy} onClick={() => { setImmersive(false); void act('finish', notes ? { notes } : {}) }}><Square size={16} />{t('Finish & save', 'إنهاء وحفظ')}</button>
          <button className="quiet big" autoFocus onClick={() => setImmersive(false)}><Minimize2 size={16} />{t('Exit (Esc)', 'خروج (Esc)')}</button>
        </div>
        <p className="muted small">{t('Drag the orb to turn it. Breathe with its slow pulse.', 'اسحب الكرة لتدويرها. تنفّس مع نبضها الهادئ.')}</p>
      </div>
    </m.div>}</AnimatePresence>
  </section>
}
