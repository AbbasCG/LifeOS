import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, csrf } from '../lib/api'
import { setAccountZone } from '../lib/accountDay'
export type User = { id: number; name: string; email: string; timezone?: string }
const AuthContext = createContext<{ user: User | null; loading: boolean; error: string; unreachable: boolean; refresh: () => Promise<void>; logout: () => Promise<void> } | null>(null)
/** The account's timezone is known before any page renders, so "today" is right from the first request. */
const known = (user: User) => { setAccountZone(user.timezone); return user }
export function AuthProvider({ children }: { children: ReactNode }) {
 const [user, setUser] = useState<User | null>(null)
 const [loading, setLoading] = useState(true)
 const [error, setError] = useState('')
 const [unreachable, setUnreachable] = useState(false)
 async function refresh() { try { setUser(known(await api<User>('/api/user'))); setError(''); setUnreachable(false) } catch (e) { setUnreachable(e instanceof ApiError && e.status === 0); setUser(null); if (!(e instanceof ApiError && e.status === 401)) setError((e as Error).message) } finally { setLoading(false) } }
 useEffect(() => { let active = true; api<User>('/api/user').then(user => { if (active) setUser(known(user)) }).catch(e => { if (!active) return; setUnreachable(e instanceof ApiError && e.status === 0); if (!(e instanceof ApiError && e.status === 401)) setError(e.message) }).finally(() => { if (active) setLoading(false) }); return () => { active = false } }, [])
 async function logout() { await csrf(); await api('/api/logout', 'POST'); setUser(null) }
 return <AuthContext.Provider value={{ user, loading, error, unreachable, refresh, logout }}>{children}</AuthContext.Provider>
}
export function useAuth() { const c = useContext(AuthContext); if (!c) throw new Error('AuthProvider missing'); return c }

