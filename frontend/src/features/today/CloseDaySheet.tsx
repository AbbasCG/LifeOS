import { useCallback, useEffect, useState } from 'react'
import { BottomSheet, SheetCancel } from '../../components/visual'
import { ErrorMessage, Skeleton } from '../../components/ui/Shared'
import { closeDay, type CloseDayResult } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { durationWords, notifyScheduleChanged } from '../../lib/taskSchedule'
import { ProposalCard } from '../assistant/ProposalCard'

/**
 * "Close the day": first what today brought (done, focus, planned, the latest titles), then what is still open rolled to the next work day
 * in the assistant's own ProposalCard (per-action choice, Apply, Not now, Undo). Opening it changes nothing; applying and undoing go
 * through the assistant proposal calls, like "Reorganize my day".
 */
export default function CloseDaySheet({ onClose }: { onClose: () => void }) {
  const t = useText(), [result, setResult] = useState<CloseDayResult | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    closeDay().then(r => { if (current) setResult(r) }, e => { if (current) setError((e as Error).message) })
    return () => { current = false }
  }, [attempt])
  const retry = () => { setError(''); setResult(null); setAttempt(n => n + 1) }
  const changed = useCallback((proposal: { status: string }, step: string) => {
    if (step !== 'dismiss') notifyScheduleChanged()
    if (proposal.status === 'dismissed') onClose()
  }, [onClose])
  const none = result && !result.proposal
  const recap = result?.recap, n = recap?.completed ?? 0
  const tasks = t(`${n} ${n === 1 ? 'task' : 'tasks'}`, n === 1 ? 'مهمة واحدة' : n === 2 ? 'مهمتان' : n <= 10 ? `${n} مهام` : `${n} مهمة`, `${n} ${n === 1 ? 'taak' : 'taken'}`)
  return <BottomSheet tall title={t('Close the day', 'أغلق اليوم', 'Dag afsluiten')} onClose={onClose}
    footer={none || error ? <>{error && <button type="button" className="primary" onClick={retry}>{t('Try again', 'حاول مجدداً', 'Opnieuw proberen')}</button>}<SheetCancel>{t('Close', 'إغلاق', 'Sluiten')}</SheetCancel></> : undefined}>
    <div aria-live="polite" aria-busy={!result && !error}>
      <ErrorMessage error={error} />
      {!result && !error && <Skeleton lines={3} />}
      {result && recap && <>
        <section aria-label={t('Today so far', 'اليوم حتى الآن', 'Vandaag tot nu toe')}>
          <p data-recap><strong>{t(`Done today: ${tasks} · ${durationWords(recap.focus_minutes, t)} focus · planned ${durationWords(recap.planned_minutes, t)}`,
            `أُنجز اليوم: ${tasks} · ${durationWords(recap.focus_minutes, t)} تركيز · ${durationWords(recap.planned_minutes, t)} مخطط`,
            `Vandaag gedaan: ${tasks} · ${durationWords(recap.focus_minutes, t)} focus · ${durationWords(recap.planned_minutes, t)} gepland`)}</strong></p>
          {recap.done_titles.length > 0 && <ul className="muted small">{recap.done_titles.slice(0, 5).map((title, i) => <li key={i}>{title}</li>)}</ul>}
        </section>
        <p>{result.summary}</p>
        {result.explanation.length > 0 && <ul className="muted small">{result.explanation.map((line, i) => <li key={i}>{line}</li>)}</ul>}
        {result.proposal && <ProposalCard proposal={{ ...result.proposal, explanation: [] }} onChange={changed} />}
      </>}
    </div>
  </BottomSheet>
}
