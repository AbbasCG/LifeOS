import { useState } from 'react'
import { Link } from 'react-router'
import { ExternalLink, CopyPlus, Link2 } from 'lucide-react'
import { api } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { ErrorMessage } from '../../components/ui/Shared'
import { formatDayText, formatDayTime } from '../../lib/clock'

export type ConnectedTask = { id: number; provider: string; source: string; account: string | null; list: string | null; title: string; due_at: string | null; due_is_date: boolean; priority: string | null; url: string | null; status?: 'open' | 'completed'; completed_at?: string | null }

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
  const due = (task: ConnectedTask) => task.due_at ? (task.due_is_date ? formatDayText(task.due_at, { language }) : formatDayTime(task.due_at, { language })) : null
  async function copy(task: ConnectedTask) {
    setBusy(task.id); setFailure('')
    try { await api(`/api/connected/tasks/${task.id}/copy`, 'POST'); toast(t(`“${task.title}” is now a LifeOS task. The original in ${task.source} is unchanged.`, `أصبحت «${task.title}» مهمة في LifeOS. الأصل في ${task.source} لم يتغير.`, `“${task.title}” is nu een LifeOS-taak. Het origineel in ${task.source} is ongewijzigd.`)); reload(); onCopied?.() } catch (e) { setFailure((e as Error).message) } finally { setBusy(null) }
  }
  return <section className="panel reveal connected-tasks" aria-labelledby="connected-tasks-title">
    <header className="row"><h2 id="connected-tasks-title"><Link2 size={18} />{t('From connected apps', 'من التطبيقات المرتبطة', 'Uit gekoppelde apps')}</h2><Link className="quiet" to="/settings/integrations">{t('Manage', 'إدارة', 'Beheren')}</Link></header>
    <p className="muted small">{t('Read-only. Copy a task into LifeOS to plan, focus on and complete it here.', 'للقراءة فقط. انسخ مهمة إلى LifeOS لتخطط لها وتركز عليها وتنجزها هنا.', 'Alleen lezen. Kopieer een taak naar LifeOS om hem hier te plannen, je erop te focussen en af te ronden.')}</p>
    <ErrorMessage error={failure} />
    <ul className="connected-list">{data.slice(0, 12).map(task => <li key={task.id} className={task.status === 'completed' ? 'done' : ''}>
      <span className={`source-badge src-${task.provider}`}>{task.source}</span>
      <div className="connected-main"><strong>{task.title}</strong><small className="muted">{[task.list, due(task)].filter(Boolean).join(' · ')}</small></div>
      {task.url && <a className="icon-button" href={task.url} target="_blank" rel="noreferrer noopener" aria-label={t(`Open in ${task.source}`, `فتح في ${task.source}`, `Openen in ${task.source}`)}><ExternalLink size={16} /></a>}
      {task.status === 'completed' ? <span className="chip">{t(`Completed in ${task.source}`, `أُنجزت في ${task.source}`, `Voltooid in ${task.source}`)}</span> : <button className="quiet" disabled={busy !== null} onClick={() => void copy(task)}><CopyPlus size={15} />{t('Copy to LifeOS', 'نسخ إلى LifeOS', 'Naar LifeOS kopiëren')}</button>}
    </li>)}</ul>
  </section>
}
