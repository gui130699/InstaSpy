import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { getSession, logout as logoutService, type SessionData } from '../services/authService'
import { db, type Account } from '../db/database'

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
  accounts: Account[]
  loading: boolean
  setSession: (s: SessionData | null) => void
  setAccountId: (id: number | null) => void
  switchAccount: (id: number) => void
  refreshAccounts: () => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextType>({
  session: null,
  accountId: null,
  accounts: [],
  loading: true,
  setSession: () => {},
  setAccountId: () => {},
  switchAccount: () => {},
  refreshAccounts: async () => {},
  logout: () => {}
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<SessionData | null>(null)
  const [accountId, setAccountIdState] = useState<number | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
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
      await loadAccounts(s.userId)
      setLoading(false)
    }
    init()
  }, [])

  async function loadAccounts(userId: number) {
    const all = await db.accounts.where('user_id').equals(userId).toArray()
    setAccounts(all)
    if (all.length === 0) return
    const storedId = localStorage.getItem(`instamonitor_active_acc_${userId}`)
    const active = (storedId ? all.find(a => a.id === Number(storedId)) : null) ?? all[0]
    setAccountIdState(active.id!)
  }

  const refreshAccounts = useCallback(async () => {
    const s = getSession()
    if (!s) return
    const all = await db.accounts.where('user_id').equals(s.userId).toArray()
    setAccounts(all)
  }, [])

  function setAccountId(id: number | null) {
    setAccountIdState(id)
  }

  function switchAccount(id: number) {
    const s = getSession()
    if (s) localStorage.setItem(`instamonitor_active_acc_${s.userId}`, String(id))
    setAccountIdState(id)
  }

  function setSession(s: SessionData | null) {
    setSessionState(s)
    if (s) loadAccounts(s.userId)
    else { setAccountIdState(null); setAccounts([]) }
  }

  function logout() {
    logoutService()
    setSessionState(null)
    setAccountIdState(null)
    setAccounts([])
  }

  return (
    <AuthContext.Provider value={{ session, accountId, accounts, loading, setSession, setAccountId, switchAccount, refreshAccounts, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
