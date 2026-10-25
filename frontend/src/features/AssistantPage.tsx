import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Send, Sparkles, ShieldCheck, Play, ListPlus, CheckCircle2, Bot, User as UserIcon, MessageSquarePlus, History, Trash2, Pencil, X, HelpCircle } from 'lucide-react'
import { api, type RecordItem, type AssistantStatus, type AssistantProposal, type TodayData } from '../lib/api'
import { useLanguage } from '../contexts/LanguageContext'
import { useText } from '../lib/i18n'
import { ErrorMessage } from '../components/ui/Shared'
import { RecordForm, useStatusLabel } from './ResourcePage'
import { useReasonLabel } from '../lib/labels'
import { useApi } from '../lib/useApi'
import { ProposalCard } from './assistant/ProposalCard'
import { ContextChips, PlanCard, SourceBadge } from './assistant/PlanCard'
import { LivingOrb } from '../components/orb/LivingOrb'
import { clientId, sendCopilot, type Choice, type ConversationList, type CopilotMessage, type Stage } from '../lib/copilot'

/**
 * The Copilot workspace: conversations with history, planning answers with alternatives, clarifying questions and
 * proposals. Every change is a proposal the user reviews and applies with a button; agreeing in chat applies nothing.
 */
export default function AssistantPage() {
  const t = useText(), { language } = useLanguage(), label = useStatusLabel(), reason = useReasonLabel()
  const [params, setParams] = useSearchParams(), linked = params.get('proposal'), active = params.get('c')
  // ?ask= pre-fills a suggested question (e.g. from the dashboard); nothing is sent until the user presses send.
  const [message, setMessage] = useState(() => params.get('ask')?.slice(0, 4000) ?? ''), [thread, setThread] = useState<{ key: string | null; items: CopilotMessage[] }>({ key: null, items: [] })
  const [busy, setBusy] = useState(false), [stage, setStage] = useState<Stage | null>(null), [error, setError] = useState('')
  const [draft, setDraft] = useState<Partial<RecordItem> | null>(null), [saved, setSaved] = useState(''), [drawer, setDrawer] = useState(false), [renaming, setRenaming] = useState<string | null>(null), [title, setTitle] = useState('')
  const end = useRef<HTMLDivElement>(null), pendingId = useRef(-1)
  // Messages belong to the open conversation; switching conversations never shows another one's messages.
  const messages = thread.key === active ? thread.items : []
  const setMessages = (update: (items: CopilotMessage[]) => CopilotMessage[]) => setThread(th => ({ key: th.key, items: update(th.key === active ? th.items : []) }))
  const { data: status } = useApi<AssistantStatus>('/api/assistant/status')
  const { data: pendingProposals } = useApi<AssistantProposal[]>('/api/assistant/proposals')
  const { data: linkedProposal } = useApi<AssistantProposal>(linked && /^[0-9a-f-]{36}$/.test(linked) ? `/api/assistant/proposals/${linked}` : null)
  const { data: list, reload: reloadList } = useApi<ConversationList>(`/api/copilot/conversations?language=${language}`)
  const { data: today } = useApi<TodayData>('/api/today')
  const conversations = list?.conversations ?? []
  const current = conversations.find(c => c.id === active)
  const defaults = language === 'ar'
    ? ['خطط أسبوعي القادم حول اجتماعاتي', 'أعطِ الأولوية للدراسة ومشاريعي', 'اعثر على ثلاث فترات تركيز دون نقل المواعيد الثابتة', 'أعد تنظيم يومي بعد مقاطعة', 'بماذا أبدأ اليوم؟', 'هل لدي تعارضات؟', 'قسّم مهمتي الأهم إلى خطوات', 'ساعدني على التأمل في أسبوعي']
    : ['Plan my next week around my meetings', 'Prioritize studying and my projects', 'Find three focus blocks without moving fixed appointments', 'Reorganize today after an interruption', 'What should I focus on today?', 'Do I have any conflicts?', 'Break down my top task into steps', 'Help me reflect on my week']
  const prompts = (list?.suggestions?.length ? list.suggestions : defaults).slice(0, 8)
  // Context chips: questions that matter right now, from today's real situation. They only fill the composer.
  const context = today ? [
    today.deadlines.some(d => d.bucket === 'overdue') && t(`Reschedule my overdue tasks`, 'أعد جدولة المهام المتأخرة'),
    today.deadlines.some(d => d.bucket === 'today') && t('Show tasks due today', 'اعرض المهام المستحقة اليوم'),
    t('Do I have any conflicts?', 'هل لدي تعارضات؟'),
    today.period === 'evening' ? t('Help me reflect on my week', 'ساعدني على التأمل في أسبوعي') : today.focus_time.free_minutes >= 30 && t('What should I focus on today?', 'بماذا أبدأ اليوم؟'),
  ].filter((x): x is string => !!x) : []
  const stages: Record<Stage, string> = {
    received: t('Reading your request…', 'أقرأ طلبك…'), context: t('Gathering only the data this needs…', 'أجمع البيانات اللازمة فقط…'),
    provider: t(`Asking ${status?.active.label ?? 'the AI provider'}…`, `أسأل ${status?.active.label ?? 'مزود الذكاء الاصطناعي'}…`), validating: t('Checking the answer…', 'أتحقق من الإجابة…'),
    planning: t('Planning around your calendar…', 'أخطط حول تقويمك…'), fallback: t('Switching to the local assistant…', 'أنتقل إلى المساعد المحلي…'), saving: t('Saving to this conversation…', 'أحفظ في المحادثة…'),
  }

  useEffect(() => {
    if (!active) return
    let alive = true
    api<{ messages: CopilotMessage[] }>(`/api/copilot/conversations/${active}`).then(r => { if (alive) setThread({ key: active, items: r.messages }) }).catch(e => { if (alive) setError((e as Error).message) })
    return () => { alive = false }
  }, [active])
  useEffect(() => { end.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' }) }, [thread, busy])

  function open(id: string | null) {
    setError(''); setSaved(''); setDrawer(false)
    const next = new URLSearchParams(params)
    next.delete('ask'); next.delete('proposal')
    if (id) next.set('c', id); else next.delete('c')
    setParams(next, { replace: false })
  }

  async function send(text: string, choice?: Choice) {
    const content = text.trim()
    if ((!content && !choice) || busy) return
    setBusy(true); setError(''); setSaved(''); setStage(null)
    if (!choice) setMessage('')
    if (thread.key !== active) setThread({ key: active, items: [] })
    const pending: CopilotMessage = { id: pendingId.current--, role: 'user', content: content || '…', intent: null, provider: null, created_at: new Date().toISOString() }
    setMessages(m => [...m, pending])
    try {
      const result = await sendCopilot({ conversation_id: active, message: content || undefined, language, client_id: clientId(), choice }, setStage)
      setThread(th => ({ key: result.conversation.id, items: [...(th.key === active ? th.items : []).filter(x => x.id !== pending.id && x.id !== result.user_message.id && x.id !== result.message.id), result.user_message, result.message] }))
      // A follow-up or alternative withdraws the earlier proposal: refresh so every card shows its current state.
      if (active && active === result.conversation.id) api<{ messages: CopilotMessage[] }>(`/api/copilot/conversations/${active}`).then(r => setThread(th => th.key === result.conversation.id ? { key: th.key, items: th.items.map(m => r.messages.find(x => x.id === m.id) ?? m) } : th)).catch(() => undefined)
      if (result.conversation.id !== active) {
        const next = new URLSearchParams(params)
        next.delete('ask'); next.set('c', result.conversation.id)
        setParams(next, { replace: true })
      }
      reloadList()
    } catch (e) {
      setMessages(m => m.filter(x => x.id !== pending.id))
      setError((e as Error).message)
      if (!choice) setMessage(content)
    } finally { setBusy(false); setStage(null) }
  }
  function submit(e: FormEvent) { e.preventDefault(); void send(message) }

  async function remove(id: string) {
    if (!window.confirm(t('Delete this conversation? Proposals you already applied stay applied.', 'حذف هذه المحادثة؟ تبقى الاقتراحات المطبقة كما هي.'))) return
    try { await api(`/api/copilot/conversations/${id}`, 'DELETE'); if (id === active) open(null); reloadList() } catch (e) { setError((e as Error).message) }
  }
  async function removeAll() {
    if (!window.confirm(t('Delete all conversations? This cannot be undone.', 'حذف كل المحادثات؟ لا يمكن التراجع عن ذلك.'))) return
    try { await api('/api/copilot/conversations', 'DELETE'); open(null); reloadList() } catch (e) { setError((e as Error).message) }
  }
  async function rename(e: FormEvent, id: string) {
    e.preventDefault()
    try { await api(`/api/copilot/conversations/${id}`, 'PATCH', { title }); setRenaming(null); reloadList() } catch (err) { setError((err as Error).message) }
  }
  async function attachSteps(reply: CopilotMessage) {
    const task = reply.tasks?.[0]
    if (!task || !reply.subtasks) return
    try {
      await api(`/api/tasks/${task.id}`, 'PATCH', { subtasks: reply.subtasks.map(s => ({ title: `${s.title} (${s.estimated_minutes} ${t('min', 'د')})`, completed: false })) })
      setSaved(t(`Steps added to “${task.title}”.`, `أُضيفت الخطوات إلى «${task.title}».`))
    } catch (e) { setError((e as Error).message) }
  }

  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
  const sidebar = <aside className={`copilot-sidebar ${drawer ? 'open' : ''}`} aria-label={t('Conversations', 'المحادثات')}>
    <div className="copilot-sidebar-head">
      <button type="button" className="primary" onClick={() => open(null)}><MessageSquarePlus size={16} />{t('New conversation', 'محادثة جديدة')}</button>
      <button type="button" className="icon-button drawer-close" onClick={() => setDrawer(false)} aria-label={t('Close history', 'إغلاق السجل')}><X size={16} /></button>
    </div>
    {conversations.length === 0 ? <p className="muted small">{t('Your conversations appear here.', 'تظهر محادثاتك هنا.')}</p> : <ul className="conversation-list">
      {conversations.map(c => <li key={c.id} className={c.id === active ? 'active' : ''}>
        {renaming === c.id ? <form onSubmit={e => void rename(e, c.id)} className="rename-form"><label className="sr-only" htmlFor={`rename-${c.id}`}>{t('Conversation title', 'عنوان المحادثة')}</label><input id={`rename-${c.id}`} value={title} maxLength={120} onChange={e => setTitle(e.target.value)} autoFocus required /><button className="icon-button" aria-label={t('Save title', 'حفظ العنوان')}><CheckCircle2 size={15} /></button></form>
          : <button type="button" className="conversation-open" aria-current={c.id === active ? 'true' : undefined} onClick={() => open(c.id)}><span>{c.title}</span><small className="muted">{new Date(c.last_message_at).toLocaleDateString(language, { day: 'numeric', month: 'short' })}</small></button>}
        <span className="conversation-tools">
          <button type="button" className="icon-button" onClick={() => { setRenaming(c.id); setTitle(c.title) }} aria-label={t(`Rename “${c.title}”`, `إعادة تسمية «${c.title}»`)}><Pencil size={13} /></button>
          <button type="button" className="icon-button" onClick={() => void remove(c.id)} aria-label={t(`Delete “${c.title}”`, `حذف «${c.title}»`)}><Trash2 size={13} /></button>
        </span>
      </li>)}
    </ul>}
    <div className="copilot-sidebar-foot">
      <p className="muted small">{t(`Kept for ${list?.retention_days ?? 90} days, then deleted automatically.`, `تُحفظ ${list?.retention_days ?? 90} يوماً ثم تُحذف تلقائياً.`)} <Link to="/settings/ai">{t('AI Control Center', 'مركز التحكم بالذكاء الاصطناعي')}</Link></p>
      {conversations.length > 0 && <button type="button" className="quiet danger" onClick={() => void removeAll()}><Trash2 size={14} />{t('Delete all conversations', 'حذف كل المحادثات')}</button>}
    </div>
  </aside>

  return <section className="page assistant-page">
    <header className="page-heading reveal copilot-companion"><LivingOrb size={96} progress={(today?.progress.overall ?? 0) / 100} mode={busy ? 'thinking' : 'idle'} label={busy ? t('Copilot is thinking', 'المساعد يفكر') : t(`Copilot companion. Today is ${today?.progress.overall ?? 0}% done.`, `رفيق المساعد. أُنجز ${today?.progress.overall ?? 0}٪ من اليوم.`)} /><div style={{ flex: 1 }}><p className="eyebrow">{t('Copilot', 'المساعد')}</p><h1>{t('Think it through', 'فكّر بوضوح')}</h1><p className="muted">{t('Suggestions you can review. Decisions that stay yours.', 'اقتراحات للمراجعة وقرارات تبقى لك.')}</p></div><Link className="quiet" to="/planning">{t('Open smart planner', 'فتح المخطط الذكي')}</Link></header>
    <div className="copilot-workspace">
      {sidebar}
      {drawer && <button type="button" className="drawer-scrim" aria-label={t('Close history', 'إغلاق السجل')} onClick={() => setDrawer(false)} />}
      <section className="panel chat-panel">
        <div className="chat-toolbar">
          <button type="button" className="quiet history-toggle" onClick={() => setDrawer(true)} aria-expanded={drawer}><History size={16} />{t('History', 'السجل')}</button>
          <h2 className="chat-title">{current?.title ?? t('New conversation', 'محادثة جديدة')}</h2>
        </div>
        <p className="privacy-note"><ShieldCheck size={16} />{status && status.active.provider !== 'local'
          ? t(`Answers come from ${status.active.label}. It receives your request, a few earlier turns and only the data the question needs (as allowed in the AI Control Center). It can only suggest changes — you approve each one.`, `تأتي الإجابات من ${status.active.label}. يتلقى طلبك وبعض الرسائل السابقة والبيانات التي يحتاجها السؤال فقط (حسب إعدادات مركز التحكم). يقترح التغييرات دون تنفيذها — أنت توافق على كل تغيير.`)
          : t('A private local assistant answers using your data on this server. It never changes anything without your confirmation.', 'يجيب مساعد محلي خاص باستخدام بياناتك على هذا الخادم، ولا يغيّر شيئاً دون تأكيدك.')}{' '}<Link to="/settings/assistant">{t('Assistant settings', 'إعدادات المساعد')}</Link></p>
        {!active && !linkedProposal && pendingProposals && pendingProposals.length > 0 && messages.length === 0 && <div className="linked-proposal">
          <p className="eyebrow">{t('Waiting for your approval', 'بانتظار موافقتك')}</p>
          {pendingProposals.map(p => <div key={p.id} className="pending-proposal"><p>{p.summary}</p><ProposalCard proposal={p} /></div>)}
        </div>}
        {linkedProposal && <div className="linked-proposal"><p className="muted">{t('Suggested by your automations', 'مقترح من الأتمتة')}</p><p>{linkedProposal.summary}</p><ProposalCard proposal={linkedProposal} /></div>}
        <div className="chat-log" aria-live="polite" aria-busy={busy}>
          {messages.length === 0 && context.some(c => !prompts.includes(c)) && <div className="context-chips" aria-label={t('Suggested for right now', 'مقترح الآن')}>{context.filter(c => !prompts.includes(c)).map(c => <button key={c} className="chip-button" disabled={busy} onClick={() => setMessage(c)}><Sparkles size={13} />{c}</button>)}</div>}
          {messages.length === 0 && <div className="chat-empty"><span className="orb"><Sparkles size={26} /></span><h2>{t('How can I help today?', 'كيف يمكنني مساعدتك اليوم؟')}</h2><p className="muted">{t('Plan your week, find focus time, recover from an interruption, or ask about priorities, deadlines and goals — in English or Arabic.', 'خطط أسبوعك، اعثر على وقت للتركيز، تعافَ من مقاطعة، أو اسأل عن الأولويات والمواعيد والأهداف — بالعربية أو الإنجليزية.')}</p></div>}
          {messages.map(m => <div key={m.id} className={`chat-turn ${m.role} reveal`}>
            <span className="chat-avatar" aria-hidden="true">{m.role === 'user' ? <UserIcon size={15} /> : <Bot size={15} />}</span>
            <div className="chat-bubble">
              {m.role === 'assistant' && <SourceBadge provider={m.provider} />}
              {m.notice && <p className="muted notice">{m.notice}</p>}
              <p className="chat-text">{m.content}</p>
              {m.clarify && m.clarify.options.length > 0 && <div className="clarify-options" role="group" aria-label={t('Choose an answer', 'اختر إجابة')}>
                <HelpCircle size={14} aria-hidden="true" />
                {m.clarify.options.map(o => <button key={o.value} type="button" className="chip-button" disabled={busy || m.id !== lastAssistant?.id} onClick={() => void send('', { type: 'option', message_id: m.id, value: o.value })}>{language === 'ar' ? o.label.ar : o.label.en}</button>)}
              </div>}
              {m.tasks && m.tasks.length > 0 && m.intent !== 'breakdown' && <ul className="chat-tasks">{m.tasks.map(task => <li key={task.id}><div><strong>{task.title}</strong><div className="metadata"><span className={`badge priority-${task.priority}`}>{label(task.priority)}</span><span>{task.estimated_minutes} {t('min', 'د')}</span>{task.reasons?.filter(r => r !== 'quick_win').map(r => <span key={r} className={`chip reason-${r}`}>{reason(r)}</span>)}</div></div><Link to={`/focus?task=${task.id}`} className="icon-button" aria-label={t('Focus on this task', 'ركّز على هذه المهمة')}><Play size={15} /></Link></li>)}</ul>}
              {m.items && m.items.length > 0 && <ul className="chat-items">{m.items.map((item, i) => <li key={`${item.type}-${item.id ?? i}`} className={`item-${item.type}`}>
                <div><strong>{item.link ? <Link to={item.link}>{item.title}</Link> : item.title}</strong>{item.status_label && <span className={`badge health-${item.status}`}>{item.status_label}</span>}{item.detail && <small className="muted">{item.detail}</small>}</div>
              </li>)}</ul>}
              {m.plan && <PlanCard plan={m.plan} disabled={busy} onAlternative={key => void send('', { type: 'alternative', message_id: m.id, value: key })} />}
              {m.proposal && <ProposalCard key={`${m.proposal.id}-${m.proposal.status}`} proposal={m.proposal} />}
              {m.subtasks && m.subtasks.length > 0 && <div className="chat-steps">
                <ol>{m.subtasks.map((step, i) => <li key={i}><span>{step.title}</span><small className="muted">{step.estimated_minutes} {t('min', 'د')}</small></li>)}</ol>
                <div className="toolbar">
                  {m.tasks?.[0] && <button className="primary" onClick={() => void attachSteps(m)}><ListPlus size={16} />{t('Add as steps to this task', 'أضفها كخطوات للمهمة')}</button>}
                  <button className="quiet" onClick={() => setDraft({ title: m.tasks?.[0]?.title ?? '', estimated_minutes: m.subtasks!.reduce((sum, s) => sum + s.estimated_minutes, 0), subtasks: m.subtasks!.map(s => ({ title: s.title, completed: false })) })}>{t('Review as new task', 'مراجعة كمهمة جديدة')}</button>
                </div>
              </div>}
              {m.role === 'assistant' && <ContextChips context={m.context} provider={m.provider} />}
            </div>
          </div>)}
          {busy && <div className="chat-turn assistant"><span className="chat-avatar"><Bot size={15} /></span><div className="chat-bubble typing-stage" role="status"><span className="typing" aria-hidden="true"><i /><i /><i /></span><span>{stage ? stages[stage] : t('Thinking…', 'جارٍ التفكير…')}</span></div></div>}
          <div ref={end} />
        </div>
        <ErrorMessage error={error} />
        {saved && <p className="success" role="status"><CheckCircle2 size={16} /> {saved}</p>}
        <div className="prompt-chips">{prompts.map(prompt => <button key={prompt} className="chip-button" disabled={busy} onClick={() => void send(prompt)}>{prompt}</button>)}</div>
        <form onSubmit={submit} className="chat-form">
          <label className="sr-only" htmlFor="assistant-input">{t('Message', 'الرسالة')}</label>
          <textarea id="assistant-input" value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(message) } }} required maxLength={4000} rows={2} placeholder={t('Ask anything about your work… (Enter to send)', 'اسأل عن عملك… (Enter للإرسال)')} />
          <button className="primary" disabled={busy || !message.trim()} aria-label={t('Send', 'إرسال')}><Send size={17} className="flip-rtl" /></button>
        </form>
        <p className="muted small approval-note">{t('Changes are only applied with the Apply button on a proposal — saying “yes” in chat never applies anything.', 'تُطبّق التغييرات فقط بزر «تطبيق» في الاقتراح — قول «نعم» في الدردشة لا يطبّق شيئاً.')}</p>
      </section>
    </div>
    {draft && <RecordForm resource="tasks" item={draft} onSave={() => setSaved(t('Task created.', 'تم إنشاء المهمة.'))} onClose={() => setDraft(null)} />}
  </section>
}
