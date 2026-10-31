import { Hand } from 'lucide-react'
import { useText } from '../lib/i18n'
import { useToast } from '../lib/toast'
import { DEFAULT_SWIPE, SWIPE_ACTIONS, resetSwipe, setSwipeAction, swipeWords, useSwipeActions, type SwipeSides } from '../lib/swipeActions'

/** Settings: what swiping a task does, to the right and to the left, like an email app. Kept on this device. */
export function SwipeSettings() {
  const t = useText(), toast = useToast(), current = useSwipeActions(), words = swipeWords(t)
  const sides: [keyof SwipeSides, string][] = [['right', t('Swipe right', 'السحب لليمين')], ['left', t('Swipe left', 'السحب لليسار')]]
  const isDefault = current.right === DEFAULT_SWIPE.right && current.left === DEFAULT_SWIPE.left
  return <section className="panel swipe-settings" aria-label={t('Swipe actions', 'إجراءات السحب')}>
    <h2><Hand size={18} aria-hidden="true" />{t('Swipe actions', 'إجراءات السحب')}</h2>
    <p className="muted">{t('Swipe a task in the list to act on it. Pick what each direction does.', 'اسحب مهمة في القائمة لتتصرف بها. اختر ما يفعله كل اتجاه.')}</p>
    <div className="swipe-fields">
      {sides.map(([side, label]) => <label key={side}>{label}
        <select value={current[side]} onChange={e => { setSwipeAction(side, e.target.value as SwipeSides[typeof side]); toast(t('Saved on this device.', 'حُفظ على هذا الجهاز.')) }}>
          {SWIPE_ACTIONS.map(a => <option key={a} value={a}>{words[a].full}</option>)}
        </select>
      </label>)}
    </div>
    <div className="toolbar"><button type="button" className="quiet" disabled={isDefault} onClick={() => { resetSwipe(); toast(t('Back to the usual swipes.', 'عادت الإجراءات المعتادة.')) }}>{t('Reset', 'إعادة الضبط')}</button></div>
  </section>
}
