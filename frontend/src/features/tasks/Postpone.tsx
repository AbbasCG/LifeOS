import { Suspense, useId, useRef, useState } from 'react'
import { Forward } from 'lucide-react'
import { useText } from '../../lib/i18n'
import { lazyPart } from '../../lib/lazyPart'
import { canPostpone, type PostponeResult, type PostponeTask } from '../../lib/postpone'

const Menu = lazyPart(() => import('./PostponeMenu').then(m => m.default))

export type PostponeProps = {
  task: PostponeTask & { status?: unknown }
  title: string
  /** After a postponement went through (the toast with Undo is already shown). */
  onDone?: (result: PostponeResult) => void
  /** A reason not to postpone right now (unsaved edits in a dialog), said in place instead of sending anything. */
  blocked?: () => string
  className?: string
}

/**
 * "Postpone" as a menu button (WAI-ARIA menu button pattern): Enter, Space or ArrowDown opens the menu on its first item, ArrowUp on its
 * last; Escape closes it and gives focus back. Not offered for a completed or cancelled task. The menu itself loads on first use.
 */
export function PostponeButton({ task, title, onDone, blocked, className = 'quiet' }: PostponeProps) {
  const t = useText(), [open, setOpen] = useState<false | 'first' | 'last'>(false), trigger = useRef<HTMLButtonElement>(null), id = useId()
  if (!canPostpone(task)) return null
  const close = (focus: boolean) => { setOpen(false); if (focus) trigger.current?.focus() }
  return <div className="rec-menu">
    <button ref={trigger} type="button" className={className} aria-haspopup="menu" aria-expanded={!!open} aria-controls={open ? id : undefined} data-postpone={task.id}
      aria-label={t(`Postpone “${title}”`, `تأجيل «${title}»`, `Uitstellen: “${title}”`)}
      onClick={() => setOpen(o => (o ? false : 'first'))}
      onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(e.key === 'ArrowDown' ? 'first' : 'last') } }}>
      <Forward size={16} aria-hidden="true" className="flip-rtl" />{t('Postpone', 'تأجيل', 'Uitstellen')}
    </button>
    {open && <Suspense fallback={null}><Menu id={id} task={task} start={open} trigger={trigger} onClose={close} onDone={onDone} blocked={blocked} /></Suspense>}
  </div>
}
