const API_BASE: string = (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE || 'http://localhost:3001/api'

// ─── Tipos de resposta da API ─────────────────────────────────────────────────

export interface LoginResponse {
  token: string
  serialized: string
  account: RemoteAccount
}

export interface TwoFactorResponse {
  requires_2fa: true
  pending_token: string
  message: string
}

export interface CheckpointResponse {
  requires_checkpoint: true
  pending_token: string
  message: string
}

export interface RestoreResponse {
  ok: boolean
  token: string
  username?: string
}

export interface RemoteAccount {
  pk: string
  username: string
  full_name: string
  avatar_url: string
  followers_count: number
  following_count: number
  posts_count: number
}

export interface RemotePost {
  post_id: string
  caption: string
  media_url: string
  created_at: number
  likes_count: number
  comments_count: number
  likers_list: string[]
}

export interface CollectResponse {
  collected_at: number
  account: RemoteAccount
  followers: string[]
  following: string[]
  posts: RemotePost[]
  has_more_followers: boolean
  has_more_following: boolean
  partial?: boolean
  skipped?: string[]
}

export interface CollectProgressResponse {
  active: boolean
  step?: string
  message?: string
  pct?: number
  latestUsers?: string[]
}

export interface ProfileSummary {
  username: string
  avatar_url: string
  followers_count: number
  following_count: number
  posts_count: number
  limited?: boolean
}

/** URL proxiada do avatar (contorna CORS e expiração de URLs do Instagram) */
export function proxyAvatarUrl(originalUrl: string): string {
  if (!originalUrl) return ''
  return `${API_BASE}/proxy/avatar?url=${encodeURIComponent(originalUrl)}`
}

// ─── Helpers HTTP ─────────────────────────────────────────────────────────────

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`)
  return data as T
}

async function get<T>(path: string, sessionToken: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'x-session-token': sessionToken }
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`)
  return data as T
}

// ─── API pública ──────────────────────────────────────────────────────────────

export const api = {
  /** Verifica se o servidor backend está rodando */
  async isOnline(): Promise<boolean> {
    try {
      const res = await fetch('http://localhost:3001/health', {
        signal: AbortSignal.timeout(3000)
      })
      return res.ok
    } catch {
      return false
    }
  },

  /** Login com usuário e senha do Instagram */
  login(username: string, password: string) {
    return post<LoginResponse | TwoFactorResponse | CheckpointResponse>('/auth/login', { username, password })
  },

  /** Verificar código 2FA */
  verify2fa(pending_token: string, code: string) {
    return post<LoginResponse>('/auth/verify-2fa', { pending_token, code })
  },

  /** Enviar código de checkpoint (verificação de segurança) */
  solveCheckpoint(pending_token: string, code: string) {
    return post<LoginResponse>('/auth/solve-checkpoint', { pending_token, code })
  },

  /** Login via Session ID (obtido no instagram.com) */
  cookieLogin(cookies: string) {
    return post<LoginResponse>('/auth/cookie-login', { cookies, userAgent: navigator.userAgent })
  },

  /** Restaurar sessão existente (do token em memória ou do estado serializado) */
  restoreSession(token: string | null, serialized: string | null) {
    return post<RestoreResponse>('/auth/restore', { token, serialized })
  },

  /** Coleta dados do Instagram. mode = lista separada por vírgula: 'followers,following,posts' */
  collect(sessionToken: string, mode?: string) {
    const q = mode ? `?mode=${encodeURIComponent(mode)}` : ''
    return get<CollectResponse>(`/collect${q}`, sessionToken)
  },

  /** Consulta o progresso da coleta em andamento */
  getCollectProgress(sessionToken: string) {
    return get<CollectProgressResponse>('/collect/progress', sessionToken)
  },

  /** Busca resumo público de um perfil (avatar, contagens) */
  fetchProfile(username: string, sessionToken: string) {
    return get<ProfileSummary>(`/profile/${encodeURIComponent(username)}`, sessionToken)
  },

  /** Remove sessão do servidor */
  async logout(sessionToken: string): Promise<void> {
    try {
      await fetch(`${API_BASE}/auth/session`, {
        method: 'DELETE',
        headers: { 'x-session-token': sessionToken }
      })
    } catch {
      // Ignora erros de logout
    }
  }
}
