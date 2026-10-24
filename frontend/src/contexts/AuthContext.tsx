import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, csrf } from '../lib/api'
export type User = { id: number; name: string; email: string }
const AuthContext = createContext<{ user: User | null; loading: boolean; error: string; refresh: () => Promise<void>; logout: () => Promise<void> } | null>(null)
export function AuthProvider({ children }: { children: ReactNode }) {
 const [user, setUser] = useState<User | null>(null)
 const [loading, setLoading] = useState(true)
 const [error, setError] = useState('')
 async function refresh() { try { setUser(await api<User>('/api/user')); setError('') } catch (e) { setUser(null); if (!(e instanceof ApiError && e.status === 401)) setError((e as Error).message) } finally { setLoading(false) } }
 useEffect(() => { let active = true; api<User>('/api/user').then(user => { if (active) setUser(user) }).catch(e => { if (active && !(e instanceof ApiError && e.status === 401)) setError(e.message) }).finally(() => { if (active) setLoading(false) }); return () => { active = false } }, [])
 async function logout() { await csrf(); await api('/api/logout', 'POST'); setUser(null) }
 return <AuthContext.Provider value={{ user, loading, error, refresh, logout }}>{children}</AuthContext.Provider>
}
export function useAuth() { const c = useContext(AuthContext); if (!c) throw new Error('AuthProvider missing'); return c }

