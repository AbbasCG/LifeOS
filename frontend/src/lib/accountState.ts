import { useText } from './i18n'
import type { ConnectedAccount } from '../features/connected/AccountCard'

export type AccountState = 'ok' | 'error' | 'revoked' | 'scope' | 'waiting'
/** The one honest state of an account, shared by the compact list and the detail card. */
export function accountState(account: ConnectedAccount): AccountState {
  return account.status === 'revoked' ? 'revoked' : account.scopes_ok === false ? 'scope' : account.retry_after ? 'waiting' : account.status === 'error' ? 'error' : 'ok'
}
export function useAccountStateLabel() {
  const t = useText()
  return (state: AccountState) => ({ ok: t('Connected', 'متصل', 'Verbonden'), error: t('Sync problem', 'مشكلة مزامنة', 'Synchronisatieprobleem'), revoked: t('Access revoked', 'أُلغي الوصول', 'Toegang ingetrokken'), scope: t('Permission missing', 'إذن ناقص', 'Recht ontbreekt'), waiting: t('Waiting for provider', 'بانتظار المزوّد', 'Wachten op provider') }[state])
}
