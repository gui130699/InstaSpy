import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { getSession, logout as logoutService, type SessionData } from '../services/authService'
import { db } from '../db/database'

interface AuthContextType {
  session: SessionData | null
  accountId: number | null
  loading: boolean
  setSession: (s: SessionData | null) => void
  logout: () => void
}

const AuthContext = createContext<AuthContextType>({
  session: null,
  accountId: null,
  loading: true,
  setSession: () => {},
  logout: () => {}
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<SessionData | null>(null)
  const [accountId, setAccountId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const s = getSession()
    setSessionState(s)
    if (s) loadAccount(s.userId)
    setLoading(false)
  }, [])

  async function loadAccount(userId: number) {
    const acc = await db.accounts.where('user_id').equals(userId).first()
    if (acc?.id) setAccountId(acc.id)
  }

  function setSession(s: SessionData | null) {
    setSessionState(s)
    if (s) loadAccount(s.userId)
    else setAccountId(null)
  }

  function logout() {
    logoutService()
    setSessionState(null)
    setAccountId(null)
  }

  return (
    <AuthContext.Provider value={{ session, accountId, loading, setSession, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
