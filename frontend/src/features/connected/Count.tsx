import { useCountUp } from '../../lib/useCountUp'
import { useText } from '../../lib/i18n'

/** A number that counts to its new value when it changes. The final number is also in the text for screen readers; `chip` adds the short "+3" that stays for a few seconds. */
export function Count({ value, chip = false }: { value: number; chip?: boolean }) {
  const { ref, delta } = useCountUp(value), t = useText()
  return <><span ref={ref} className="num" aria-hidden="true" /><span className="sr-only">{value}</span>{chip && delta > 0 && <> <span className="pill pill-ok">+{delta}<span className="sr-only"> {t('more than before', 'أكثر من قبل', 'meer dan eerder')}</span></span></>}</>
}
