import { Suspense, useState } from 'react'
import { HeartPulse, SlidersHorizontal } from 'lucide-react'
import { api, type Checkin, type TodayData } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { lazyPart } from '../../lib/lazyPart'
import { Dialog } from '../../components/ui/Shared'

const CheckinCard = lazyPart(() => import('../wellbeing/CheckinCard').then(m => m.CheckinCard))

/**
 * One-tap daily check-in on Today: tap how energetic you feel (1–5) and it is saved for today, the same energy value the
 * full check-in holds (only the energy is sent, so nothing already saved is touched). "More" opens the full check-in.
 * It is shown only while today has no energy answer yet and the account has check-ins on.
 */
export function QuickCheckin({ today, onSaved }: { today: TodayData; onSaved: () => void }) {
  const t = useText(), toast = useToast()
  const [busy, setBusy] = useState<number | null>(null), [more, setMore] = useState(false)
  const words = [t('Drained', 'مستنزف'), t('Low', 'منخفضة'), t('Okay', 'معتدلة'), t('Good', 'جيدة'), t('Great', 'نشيط')]
  async function pick(level: number) {
    setBusy(level)
    try {
      await api<Checkin>(`/api/checkins/${today.date}`, 'PUT', { energy: level })
      toast(t(`Energy ${level}/5 saved for today. You can add more under “More for today”.`, `حُفظت الطاقة ${level}/5 لليوم. يمكنك إضافة المزيد من «المزيد لليوم».`))
      onSaved()
    } catch (e) { toast((e as Error).message, 'error'); setBusy(null) }
  }
  return <section className="panel quick-checkin" aria-label={t('Quick check-in', 'تسجيل سريع')}>
    <div className="quick-checkin-head">
      <h2><HeartPulse size={17} aria-hidden="true" />{t('How’s your energy today?', 'كيف طاقتك اليوم؟')}</h2>
      <button type="button" className="quiet" onClick={() => setMore(true)}><SlidersHorizontal size={15} aria-hidden="true" />{t('More', 'المزيد')}</button>
    </div>
    <div className="quick-checkin-scale" role="group" aria-label={t('Energy today, 1 to 5', 'الطاقة اليوم من 1 إلى 5')}>
      {words.map((word, i) => <button key={word} type="button" disabled={busy !== null} onClick={() => void pick(i + 1)}><strong>{i + 1}</strong>{' '}<small>{word}</small></button>)}
    </div>
    {more && <Dialog title={t('Daily check-in', 'تسجيل اليوم')} onClose={() => setMore(false)}>
      <Suspense fallback={null}><CheckinCard compact initial={today.energy.checkin} date={today.date} onSaved={() => { setMore(false); onSaved() }} /></Suspense>
    </Dialog>}
  </section>
}
