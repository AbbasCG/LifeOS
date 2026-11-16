import { useCallback, useEffect, useState } from 'react'
import { BottomSheet, SheetCancel } from '../../components/visual'
import { ErrorMessage, Skeleton } from '../../components/ui/Shared'
import { reorganizeDay, type ReorganizeResult } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { notifyScheduleChanged } from '../../lib/taskSchedule'
import { ProposalCard } from '../assistant/ProposalCard'

/**
 * The preview of "Reorganize my day": what slipped, why, and the proposed sessions in the assistant's own ProposalCard (per-action
 * choice, Apply, Not now, Undo). Asking for the preview changes nothing; applying and undoing go through the assistant proposal calls.
 */
export default function ReorganizeSheet({ onClose }: { onClose: () => void }) {
  const t = useText(), [result, setResult] = useState<ReorganizeResult | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    reorganizeDay().then(r => { if (current) setResult(r) }, e => { if (current) setError((e as Error).message) })
    return () => { current = false }
  }, [attempt])
  const retry = () => { setError(''); setResult(null); setAttempt(n => n + 1) }
  const changed = useCallback((proposal: { status: string }, step: string) => {
    // New or removed sessions: Today, the calendar and the task lists read the server again.
    if (step !== 'dismiss') notifyScheduleChanged()
    if (proposal.status === 'dismissed') onClose()
  }, [onClose])
  const none = result && !result.proposal
  return <BottomSheet tall title={t('Reorganize my day', 'أعد تنظيم يومي', 'Herorganiseer mijn dag')} onClose={onClose}
    footer={none || error ? <>{error && <button type="button" className="primary" onClick={retry}>{t('Try again', 'حاول مجدداً', 'Opnieuw proberen')}</button>}<SheetCancel>{t('Close', 'إغلاق', 'Sluiten')}</SheetCancel></> : undefined}>
    <div aria-live="polite" aria-busy={!result && !error}>
      <ErrorMessage error={error} />
      {!result && !error && <Skeleton lines={3} />}
      {result && <>
        <p><strong>{result.summary}</strong></p>
        {result.explanation.length > 0 && <ul className="muted small">{result.explanation.map((line, i) => <li key={i}>{line}</li>)}</ul>}
        {result.proposal && <ProposalCard proposal={{ ...result.proposal, explanation: [] }} onChange={changed} />}
      </>}
    </div>
  </BottomSheet>
}
