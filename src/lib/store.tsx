import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, type User } from './api'

interface Session { user: User | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void> }
const Ctx = createContext<Session>({ user: null, loading: true, refresh: async () => {}, logout: async () => {} })
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null); const [loading, setLoading] = useState(true)
  const refresh = useCallback(async () => { try { const r = await api.get<{ user: User | null }>('/auth/me'); setUser(r.user) } catch { setUser(null) } finally { setLoading(false) } }, [])
  useEffect(() => { void refresh() }, [refresh])
  const logout = useCallback(async () => { await api.post('/auth/logout'); setUser(null) }, [])
  return <Ctx.Provider value={{ user, loading, refresh, logout }}>{children}</Ctx.Provider>
}
export const useSession = () => useContext(Ctx)
