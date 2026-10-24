import { useState } from 'react'
import { Bot, Cpu, ShieldCheck, CheckCircle2, Server } from 'lucide-react'
import { api, type AssistantStatus } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { ErrorMessage, Skeleton } from '../../components/ui/Shared'

export default function AssistantSettings() {
  const t = useText(), toast = useToast()
  const { data, error, reload } = useApi<AssistantStatus>('/api/assistant/status')
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState('')
  async function setExternal(allowed: boolean) {
    setBusy(true); setFailure('')
    try { await api('/api/settings', 'PUT', { assistant_external: allowed }); toast(allowed ? t('External AI enabled.', 'تم تفعيل الذكاء الاصطناعي الخارجي.') : t('Only the local assistant will answer.', 'سيجيب المساعد المحلي فقط.')); reload() } catch (e) { setFailure((e as Error).message) } finally { setBusy(false) }
  }
  if (error) return <ErrorMessage error={error} />
  if (!data) return <Skeleton lines={4} />
  const anyConfigured = data.providers.some(p => p.configured)
  return <div className="settings-stack">
    <section className="panel reveal integration-intro">
      <ShieldCheck size={22} />
      <div><h2>{t('Assistant', 'المساعد')}</h2><p className="muted">{t('The assistant reads only your own tasks, calendar and habits. It can propose schedules and changes, but nothing is saved until you approve each item. Without an AI provider, a private local assistant answers on this server.', 'يقرأ المساعد مهامك وتقويمك وعاداتك فقط. يمكنه اقتراح جداول وتغييرات، لكن لا يُحفظ شيء قبل موافقتك على كل عنصر. بدون مزود ذكاء اصطناعي، يجيب مساعد محلي خاص على هذا الخادم.')}</p></div>
    </section>
    <section className="panel reveal">
      <h2><Bot size={18} /> {t('Currently answering', 'المجيب حالياً')}</h2>
      <p className="assistant-active"><strong>{data.active.provider === 'local' ? t('Local assistant', 'المساعد المحلي') : data.active.label}</strong>{data.active.model && <span className="badge">{data.active.model}</span>}</p>
      <ul className="provider-list">{data.providers.map(p => <li key={p.provider}>
        <Cpu size={16} /><span>{p.label}</span>
        {p.configured ? <span className="badge ok"><CheckCircle2 size={13} /> {p.selected ? t('Configured · selected', 'مُعد · مختار') : t('Configured', 'مُعد')}</span> : <span className="badge muted">{t('Not configured', 'غير مُعد')}</span>}
      </li>)}</ul>
      {!anyConfigured && <div className="setup-note"><Server size={16} /><div><p>{t('To use Claude or OpenAI, an administrator sets these on the server (never in the browser):', 'لاستخدام Claude أو OpenAI، يضبط المسؤول هذه القيم على الخادم (وليس في المتصفح):')}</p><code>AI_PROVIDER=anthropic · ANTHROPIC_API_KEY · ANTHROPIC_MODEL</code><code>AI_PROVIDER=openai · OPENAI_API_KEY · OPENAI_MODEL</code></div></div>}
    </section>
    {anyConfigured && <section className="panel reveal">
      <label className="toggle-row">
        <input type="checkbox" checked={data.external_allowed} disabled={busy} onChange={e => void setExternal(e.target.checked)} />
        <span><strong>{t('Allow the external AI provider', 'السماح بمزود الذكاء الاصطناعي الخارجي')}</strong><small className="muted">{t('When on, your request plus relevant task and event titles are sent to the provider. When off, only the local assistant answers and nothing leaves this server.', 'عند التفعيل، يُرسل طلبك مع عناوين المهام والمواعيد ذات الصلة إلى المزوّد. عند الإيقاف، يجيب المساعد المحلي فقط ولا يغادر شيء هذا الخادم.')}</small></span>
      </label>
      <ErrorMessage error={failure} />
    </section>}
  </div>
}
