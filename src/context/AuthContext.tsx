import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { getSession, logout as logoutService, type SessionData } from '../services/authService'
import { db } from '../db/database'

const DEFAULT_USER_KEY = 'instamonitor_default_uid'

async function getOrCreateDefaultUser(): Promise<SessionData> {
  // Reutiliza usuário existente pelo ID salvo
  const savedId = localStorage.getItem(DEFAULT_USER_KEY)
  if (savedId) {
    const user = await db.users.get(Number(savedId))
    if (user) return { userId: user.id!, email: user.email, nome: user.nome }
  }
  // Cria usuário padrão silencioso
  const existing = await db.users.where('email').equals('local@instamonitor').first()
  if (existing) {
    localStorage.setItem(DEFAULT_USER_KEY, String(existing.id!))
    return { userId: existing.id!, email: existing.email, nome: existing.nome }
  }
  const id = await db.users.add({
    email: 'local@instamonitor',
    senha_hash: '',
    nome: 'Usuário',
    created_at: Date.now()
  })
  localStorage.setItem(DEFAULT_USER_KEY, String(id))
  return { userId: id as number, email: 'local@instamonitor', nome: 'Usuário' }
}

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
    async function init() {
      // Sempre mantém sessão ativa (sem tela de login)
      let s = getSession()
      if (!s) {
        s = await getOrCreateDefaultUser()
        sessionStorage.setItem('instamonitor_session', JSON.stringify(s))
      }
      setSessionState(s)
      await loadAccount(s.userId)
      setLoading(false)
    }
    init()
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
