import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { accountState, type AccountState } from '../../lib/accountState'
import { relativeTime } from '../../lib/relativeTime'
import type { ConnectedAccount } from './AccountCard'

export type Health = 'ok' | 'warn' | 'bad' | 'idle'
const HEALTH: Record<AccountState, Health> = { ok: 'ok', error: 'warn', waiting: 'warn', revoked: 'bad', scope: 'bad' }
export const isBroken = (state: AccountState) => state === 'revoked' || state === 'scope'

/**
 * The state of one account as a sentence, built only from what the server sent: when it last synced, when the provider lets it retry, what the last error said.
 * `chip` is the short sentence on the hub row; `since` is the "last synced" sentence a failing account adds. `now` is injectable so the wording can be tested.
 */
export function useStateLine() {
  const t = useText(), { language } = useLanguage()
  return (account: ConnectedAccount, syncing = false, now: number = Date.now()) => {
    const state = accountState(account)
    const synced = relativeTime(account.last_synced_at, language, now)
    const lastOn = (r: NonNullable<typeof synced>) => r.kind === 'date' ? t(`Last synced on ${r.text}`, `آخر مزامنة في ${r.text}`, `Laatst gesynchroniseerd op ${r.text}`) : t(`Last synced ${r.text}`, `آخر مزامنة ${r.text}`, `Laatst gesynchroniseerd ${r.text}`)
    const since = synced ? lastOn(synced) : t('No successful sync yet', 'لا توجد مزامنة ناجحة بعد', 'Nog geen geslaagde synchronisatie')
    const retry = relativeTime(account.retry_after, language, now)
    const chip = syncing ? t('Syncing…', 'جارٍ المزامنة…', 'Synchroniseren…')
      : state === 'revoked' ? t('Access revoked', 'أُلغي الوصول', 'Toegang ingetrokken')
      : state === 'scope' ? t('Missing permission', 'إذن ناقص', 'Recht ontbreekt')
      : state === 'waiting' ? (retry && retry.kind === 'relative' && retry.future ? t(`Next try ${retry.text}`, `المحاولة التالية ${retry.text}`, `Volgende poging ${retry.text}`) : t('Next try shortly', 'المحاولة التالية قريبًا', 'Volgende poging binnenkort'))
      : state === 'error' ? t('Sync problem', 'مشكلة مزامنة', 'Synchronisatieprobleem')
      : !synced ? t('Not synced yet', 'لم تتم المزامنة بعد', 'Nog niet gesynchroniseerd')
      : synced.kind === 'date' ? lastOn(synced) : t(`Synced ${synced.text}`, `تمت المزامنة ${synced.text}`, `Gesynchroniseerd ${synced.text}`)
    return { state, s: syncing ? 'idle' as Health : HEALTH[state], chip, since, syncing }
  }
}

/** What LifeOS may do with the account, in a few words. Accounts without permission choices (feeds, task lists) are read-only unless writing was switched on. */
export function usePresetLabel() {
  const t = useText()
  return (account: ConnectedAccount) => {
    const p = account.permissions
    const preset = p ? p.preset : account.write?.enabled ? 'read_create' : 'read_only'
    return preset === null ? t('Custom', 'مخصص', 'Aangepast')
      : { read_only: t('Read only', 'قراءة فقط', 'Alleen lezen'), read_create: t('Can add events', 'يضيف مواعيد', 'Kan afspraken toevoegen'), read_create_update: t('Can edit events', 'يعدّل المواعيد', 'Kan afspraken bewerken'), full: t('Full access', 'وصول كامل', 'Volledige toegang') }[preset]
  }
}
