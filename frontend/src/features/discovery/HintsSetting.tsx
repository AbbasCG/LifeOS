import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { setHintsEnabled } from '../../lib/discovery'

/** The one switch for contextual tips. Turning it off stops hints for good; announcements and the update history are separate. */
export function HintsSetting() {
  const t = useText(), [on, setOn] = useState<boolean | null>(null), [failed, setFailed] = useState(false)
  useEffect(() => { api<{ discovery?: { hints_enabled?: boolean } }>('/api/settings').then(p => setOn(p.discovery?.hints_enabled !== false)).catch(() => setOn(true)) }, [])
  if (on === null) return null
  const change = (value: boolean) => { setOn(value); setFailed(false); setHintsEnabled(value).catch(() => { setOn(!value); setFailed(true) }) }
  return <section className="panel hints-setting">
    <label className="inline"><input type="checkbox" checked={on} onChange={e => change(e.target.checked)} />{t('Show tips when I first use a feature', 'إظهار تلميحات عند أول استخدام لميزة', 'Toon tips als ik een functie voor het eerst gebruik')}</label>
    <p className="muted">{t('Each tip appears once. What’s new and the update history are not affected.', 'يظهر كل تلميح مرة واحدة فقط. لا يتأثر «ما الجديد» ولا سجل التحديثات.', 'Elke tip verschijnt één keer. Wat is nieuw en de updategeschiedenis blijven zoals ze zijn.')}</p>
    {failed && <p className="error" role="alert">{t('Could not save. Try again.', 'تعذّر الحفظ. حاول مجددًا.', 'Opslaan lukte niet. Probeer opnieuw.')}</p>}
  </section>
}
