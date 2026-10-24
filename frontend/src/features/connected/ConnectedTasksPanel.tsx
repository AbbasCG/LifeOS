import { useState } from 'react'
import { Link } from 'react-router'
import { ExternalLink, CopyPlus, Link2 } from 'lucide-react'
import { api } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { ErrorMessage } from '../../components/ui/Shared'

export type ConnectedTask = { id: number; provider: string; source: string; account: string | null; list: string | null; title: string; due_at: string | null; due_is_date: boolean; priority: string | null; url: string | null }

/**
 * Read-only tasks from connected apps. They stay owned by their source; copying one creates a LifeOS task that can be
 * planned and completed here, and the imported copy disappears from this list so nothing is shown twice.
 */
export function ConnectedTasksPanel({ onCopied }: { onCopied?: () => void }) {
  const t = useText(), { language } = useLanguage(), toast = useToast()
  // Supplementary panel: load problems are shown on the Connected accounts page, so a failed load renders nothing here.
  const { data, reload } = useApi<ConnectedTask[]>('/api/connected/tasks')
  const [busy, setBusy] = useState<number | null>(null), [failure, setFailure] = useState('')
  if (!data || data.length === 0) return null
  const due = (task: ConnectedTask) => task.due_at ? new Date(task.due_at).toLocaleString(language, task.due_is_date ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null
  async function copy(task: ConnectedTask) {
    setBusy(task.id); setFailure('')
    try { await api(`/api/connected/tasks/${task.id}/copy`, 'POST'); toast(t(`“${task.title}” is now a LifeOS task. The original in ${task.source} is unchanged.`, `أصبحت «${task.title}» مهمة في LifeOS. الأصل في ${task.source} لم يتغير.`)); reload(); onCopied?.() } catch (e) { setFailure((e as Error).message) } finally { setBusy(null) }
  }
  return <section className="panel reveal connected-tasks" aria-labelledby="connected-tasks-title">
    <header className="row"><h2 id="connected-tasks-title"><Link2 size={18} />{t('From connected apps', 'من التطبيقات المرتبطة')}</h2><Link className="quiet" to="/settings/integrations">{t('Manage', 'إدارة')}</Link></header>
    <p className="muted small">{t('Read-only. Copy a task into LifeOS to plan, focus on and complete it here.', 'للقراءة فقط. انسخ مهمة إلى LifeOS لتخطط لها وتركز عليها وتنجزها هنا.')}</p>
    <ErrorMessage error={failure} />
    <ul className="connected-list">{data.slice(0, 12).map(task => <li key={task.id}>
      <span className={`source-badge src-${task.provider}`}>{task.source}</span>
      <div className="connected-main"><strong>{task.title}</strong><small className="muted">{[task.list, due(task)].filter(Boolean).join(' · ')}</small></div>
      {task.url && <a className="icon-button" href={task.url} target="_blank" rel="noreferrer noopener" aria-label={t(`Open in ${task.source}`, `فتح في ${task.source}`)}><ExternalLink size={16} /></a>}
      <button className="quiet" disabled={busy !== null} onClick={() => void copy(task)}><CopyPlus size={15} />{t('Copy to LifeOS', 'نسخ إلى LifeOS')}</button>
    </li>)}</ul>
  </section>
}
