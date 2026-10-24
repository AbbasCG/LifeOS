import { api } from './api'

export type PushState = 'unsupported' | 'no-worker' | 'not-configured' | 'denied' | 'enabled' | 'available'

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

function keyBytes(base64url: string) {
  const raw = atob(base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - base64url.length % 4) % 4))
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

async function registration() {
  return pushSupported() ? (await navigator.serviceWorker.getRegistration()) ?? null : null
}

/** Current push state for this browser, without prompting. */
export async function pushState(configured: boolean): Promise<PushState> {
  if (!pushSupported()) return 'unsupported'
  if (!configured) return 'not-configured'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await registration()
  if (!reg) return 'no-worker'
  return (await reg.pushManager.getSubscription()) && Notification.permission === 'granted' ? 'enabled' : 'available'
}

/** Ask for permission (only from a user gesture) and register this device with the server. */
export async function enablePush(publicKey: string): Promise<PushState> {
  const reg = await registration()
  if (!reg) return 'no-worker'
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'available'
  const subscription = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
  const json = subscription.toJSON()
  await api('/api/push/subscriptions', 'POST', { endpoint: json.endpoint, keys: json.keys })
  return 'enabled'
}

export async function disablePush(): Promise<void> {
  const subscription = await (await registration())?.pushManager.getSubscription()
  if (!subscription) return
  await api('/api/push/unsubscribe', 'POST', { endpoint: subscription.endpoint })
  await subscription.unsubscribe()
}
