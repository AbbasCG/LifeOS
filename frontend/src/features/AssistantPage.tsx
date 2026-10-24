import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Send, Sparkles, ShieldCheck, Play, ListPlus, CheckCircle2, Bot, User as UserIcon } from 'lucide-react'
import { api, type AssistantReply, type RecordItem } from '../lib/api'
import { useLanguage } from '../contexts/LanguageContext'
import { useText } from '../lib/i18n'
import { ErrorMessage } from '../components/ui/Shared'
import { RecordForm, useStatusLabel } from './ResourcePage'
import { useReasonLabel } from '../lib/labels'
import { useApi } from '../lib/useApi'
import { ProposalCard } from './assistant/ProposalCard'
import type { AssistantStatus, AssistantProposal, TodayData } from '../lib/api'
import { LivingOrb } from '../components/orb/LivingOrb'

type Turn = { id: number; role: 'user' | 'assistant'; text: string; reply?: AssistantReply }

export default function AssistantPage() {
  const t = useText(), { language } = useLanguage(), label = useStatusLabel(), reason = useReasonLabel()
  const [params] = useSearchParams(), linked = params.get('proposal')
  // ?ask= pre-fills a suggested question (e.g. from the dashboard); nothing is sent until the user presses send.
  const [message, setMessage] = useState(() => params.get('ask')?.slice(0, 4000) ?? ''), [turns, setTurns] = useState<Turn[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [draft, setDraft] = useState<Partial<RecordItem> | null>(null), [saved, setSaved] = useState<string>('')
  const end = useRef<HTMLDivElement>(null), nextId = useRef(1)
  const { data: status } = useApi<AssistantStatus>('/api/assistant/status')
  const { data: pendingProposals } = useApi<AssistantProposal[]>('/api/assistant/proposals')
  const { data: linkedProposal } = useApi<AssistantProposal>(linked && /^[0-9a-f-]{36}$/.test(linked) ? `/api/assistant/proposals/${linked}` : null)
  const providerLabel = (p: string) => p === 'local' ? t('Local assistant', 'مساعد محلي') : p === 'anthropic' ? 'Claude' : p === 'openai' ? 'OpenAI' : t('AI suggestion', 'اقتراح ذكاء اصطناعي')
  const defaults = language === 'ar'
    ? ['بماذا أبدأ اليوم؟', 'لدي ٤ ساعات غداً. جدول الدراسة والبرمجة والرياضة.', 'هل لدي تعارضات؟', 'اعرض المهام ذات الأولوية العالية هذا الأسبوع', 'ضع خطة لهدفي', 'أعد جدولة المهام المتأخرة', 'قسّم مهمتي الأهم إلى خطوات', 'ساعدني على التأمل في أسبوعي']
    : ['What should I focus on today?', 'I have 4 hours tomorrow. Schedule studying, programming and exercise.', 'Do I have any conflicts?', 'Show high priority tasks due this week', 'Plan my goal', 'Reschedule my overdue tasks', 'Break down my top task into steps', 'Help me reflect on my week']
  const { data: today } = useApi<TodayData>('/api/today')
  // Context chips: questions that matter right now, from today's real situation. They only fill the composer.
  const context = today ? [
    today.deadlines.some(d => d.bucket === 'overdue') && t(`Reschedule my overdue tasks`, 'أعد جدولة المهام المتأخرة'),
    today.deadlines.some(d => d.bucket === 'today') && t('Show tasks due today', 'اعرض المهام المستحقة اليوم'),
    t('Do I have any conflicts?', 'هل لدي تعارضات؟'),
    today.period === 'evening' ? t('Help me reflect on my week', 'ساعدني على التأمل في أسبوعي') : today.focus_time.free_minutes >= 30 && t('What should I focus on today?', 'بماذا أبدأ اليوم؟'),
  ].filter((x): x is string => !!x) : []
  const lastReply = [...turns].reverse().find(turn => turn.reply)?.reply
  const prompts = lastReply?.suggestions?.length ? lastReply.suggestions : defaults
  useEffect(() => { end.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' }) }, [turns, busy])

  async function ask(text: string) {
    const content = text.trim()
    if (!content || busy) return
    setBusy(true); setError(''); setSaved(''); setMessage('')
    setTurns(list => [...list, { id: nextId.current++, role: 'user', text: content }])
    try {
      const reply = await api<AssistantReply>('/api/assistant', 'POST', { message: content, language })
      setTurns(list => [...list, { id: nextId.current++, role: 'assistant', text: reply.message, reply }])
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  function submit(e: FormEvent) { e.preventDefault(); void ask(message) }
  async function attachSteps(reply: AssistantReply) {
    const task = reply.tasks[0]
    if (!task) return
    try {
      await api(`/api/tasks/${task.id}`, 'PATCH', { subtasks: reply.subtasks.map(s => ({ title: `${s.title} (${s.estimated_minutes} ${t('min', 'د')})`, completed: false })) })
      setSaved(t(`Steps added to “${task.title}”.`, `أُضيفت الخطوات إلى «${task.title}».`))
    } catch (e) { setError((e as Error).message) }
  }

  return <section className="page assistant-page">
    <header className="page-heading reveal copilot-companion"><LivingOrb size={96} progress={(today?.progress.overall ?? 0) / 100} mode={busy ? 'thinking' : 'idle'} label={busy ? t('Copilot is thinking', 'المساعد يفكر') : t(`Copilot companion. Today is ${today?.progress.overall ?? 0}% done.`, `رفيق المساعد. أُنجز ${today?.progress.overall ?? 0}٪ من اليوم.`)} /><div style={{ flex: 1 }}><p className="eyebrow">{t('Copilot', 'المساعد')}</p><h1>{t('Think it through', 'فكّر بوضوح')}</h1><p className="muted">{t('Suggestions you can review. Decisions that stay yours.', 'اقتراحات للمراجعة وقرارات تبقى لك.')}</p></div><Link className="quiet" to="/planning">{t('Open smart planner', 'فتح المخطط الذكي')}</Link></header>
    <section className="panel chat-panel">
      <p className="privacy-note"><ShieldCheck size={16} />{status && status.active.provider !== 'local'
        ? t(`Answers come from ${status.active.label}. It receives only your request and the task and calendar titles it needs, and it can only suggest changes — you approve each one.`, `تأتي الإجابات من ${status.active.label}. يتلقى طلبك وعناوين المهام والمواعيد اللازمة فقط، ويقترح التغييرات دون تنفيذها — أنت توافق على كل تغيير.`)
        : t('A private local assistant answers using your data on this server. It never changes anything without your confirmation.', 'يجيب مساعد محلي خاص باستخدام بياناتك على هذا الخادم، ولا يغيّر شيئاً دون تأكيدك.')}{' '}<Link to="/settings/assistant">{t('Assistant settings', 'إعدادات المساعد')}</Link></p>
      {!linkedProposal && pendingProposals && pendingProposals.length > 0 && turns.length === 0 && <div className="linked-proposal">
        <p className="eyebrow">{t('Waiting for your approval', 'بانتظار موافقتك')}</p>
        {pendingProposals.map(p => <div key={p.id} className="pending-proposal"><p>{p.summary}</p><ProposalCard proposal={p} /></div>)}
      </div>}
      {linkedProposal && <div className="linked-proposal"><p className="muted">{t('Suggested by your automations', 'مقترح من الأتمتة')}</p><p>{linkedProposal.summary}</p><ProposalCard proposal={linkedProposal} /></div>}
      <div className="chat-log" aria-live="polite">
        {turns.length === 0 && context.some(c => !prompts.includes(c)) && <div className="context-chips" aria-label={t('Suggested for right now', 'مقترح الآن')}>{context.filter(c => !prompts.includes(c)).map(c => <button key={c} className="chip-button" disabled={busy} onClick={() => setMessage(c)}><Sparkles size={13} />{c}</button>)}</div>}
        {turns.length === 0 && <div className="chat-empty"><span className="orb"><Sparkles size={26} /></span><h2>{t('How can I help today?', 'كيف يمكنني مساعدتك اليوم؟')}</h2><p className="muted">{t('Ask about priorities, deadlines, conflicts, goals, habits or your week — in English or Arabic.', 'اسأل عن الأولويات أو المواعيد أو التعارضات أو الأهداف أو العادات أو أسبوعك — بالعربية أو الإنجليزية.')}</p></div>}
        {turns.map(turn => <div key={turn.id} className={`chat-turn ${turn.role} reveal`}>
          <span className="chat-avatar" aria-hidden="true">{turn.role === 'user' ? <UserIcon size={15} /> : <Bot size={15} />}</span>
          <div className="chat-bubble">
            {turn.reply && <span className="badge">{providerLabel(turn.reply.provider)}</span>}
            {turn.reply?.notice && <p className="muted notice">{turn.reply.notice}</p>}
            <p className="chat-text">{turn.text}</p>
            {turn.reply && turn.reply.tasks.length > 0 && turn.reply.intent !== 'breakdown' && <ul className="chat-tasks">{turn.reply.tasks.map(task => <li key={task.id}><div><strong>{task.title}</strong><div className="metadata"><span className={`badge priority-${task.priority}`}>{label(task.priority)}</span><span>{task.estimated_minutes} {t('min', 'د')}</span>{task.reasons?.filter(r => r !== 'quick_win').map(r => <span key={r} className={`chip reason-${r}`}>{reason(r)}</span>)}</div></div><Link to={`/focus?task=${task.id}`} className="icon-button" aria-label={t('Focus on this task', 'ركّز على هذه المهمة')}><Play size={15} /></Link></li>)}</ul>}
            {turn.reply?.items && turn.reply.items.length > 0 && <ul className="chat-items">{turn.reply.items.map((item, i) => <li key={`${item.type}-${item.id ?? i}`} className={`item-${item.type}`}>
              <div><strong>{item.link ? <Link to={item.link}>{item.title}</Link> : item.title}</strong>{item.status_label && <span className={`badge health-${item.status}`}>{item.status_label}</span>}{item.detail && <small className="muted">{item.detail}</small>}</div>
            </li>)}</ul>}
            {turn.reply?.proposal && <ProposalCard proposal={turn.reply.proposal} />}
            {turn.reply && turn.reply.subtasks.length > 0 && <div className="chat-steps">
              <ol>{turn.reply.subtasks.map((step, i) => <li key={i}><span>{step.title}</span><small className="muted">{step.estimated_minutes} {t('min', 'د')}</small></li>)}</ol>
              <div className="toolbar">
                {turn.reply.tasks[0] && <button className="primary" onClick={() => void attachSteps(turn.reply!)}><ListPlus size={16} />{t('Add as steps to this task', 'أضفها كخطوات للمهمة')}</button>}
                <button className="quiet" onClick={() => setDraft({ title: turn.reply!.tasks[0]?.title ?? '', estimated_minutes: turn.reply!.subtasks.reduce((sum, s) => sum + s.estimated_minutes, 0), subtasks: turn.reply!.subtasks.map(s => ({ title: s.title, completed: false })) })}>{t('Review as new task', 'مراجعة كمهمة جديدة')}</button>
              </div>
            </div>}
          </div>
        </div>)}
        {busy && <div className="chat-turn assistant"><span className="chat-avatar"><Bot size={15} /></span><div className="chat-bubble typing" aria-label={t('Thinking…', 'جارٍ التفكير…')}><i /><i /><i /></div></div>}
        <div ref={end} />
      </div>
      <ErrorMessage error={error} />
      {saved && <p className="success" role="status"><CheckCircle2 size={16} /> {saved}</p>}
      <div className="prompt-chips">{prompts.map(prompt => <button key={prompt} className="chip-button" disabled={busy} onClick={() => void ask(prompt)}>{prompt}</button>)}</div>
      <form onSubmit={submit} className="chat-form">
        <label className="sr-only" htmlFor="assistant-input">{t('Message', 'الرسالة')}</label>
        <textarea id="assistant-input" value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(message) } }} required maxLength={4000} rows={2} placeholder={t('Ask anything about your work… (Enter to send)', 'اسأل عن عملك… (Enter للإرسال)')} />
        <button className="primary" disabled={busy || !message.trim()} aria-label={t('Send', 'إرسال')}><Send size={17} className="flip-rtl" /></button>
      </form>
    </section>
    {draft && <RecordForm resource="tasks" item={draft} onSave={() => setSaved(t('Task created.', 'تم إنشاء المهمة.'))} onClose={() => setDraft(null)} />}
  </section>
}
