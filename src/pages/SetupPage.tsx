import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { db } from '../db/database'
import { useAuth } from '../context/AuthContext'
import { initMockData } from '../services/mockCollector'
import { api } from '../services/apiClient'
import type { LoginResponse } from '../services/apiClient'

export default function SetupPage() {
  const [cookieValue, setCookieValue] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [serverStatus, setServerStatus] = useState<'checking' | 'online' | 'offline'>('checking')
  const { session, setSession } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    async function check() {
      const online = await api.isOnline()
      if (!cancelled) setServerStatus(online ? 'online' : 'offline')
    }
    check()
    const interval = setInterval(check, 4000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  async function finishSetup(loginData: LoginResponse) {
    if (!session) return
    const existing = await db.accounts.where('user_id').equals(session.userId).first()
    if (existing) {
      await db.accounts.update(existing.id!, {
        username: loginData.account.username,
        session_token: loginData.token,
        serialized_session: loginData.serialized,
        instagram_pk: loginData.account.pk,
        avatar_url: loginData.account.avatar_url,
        last_sync: Date.now()
      })
    } else {
      await db.accounts.add({
        user_id: session.userId,
        username: loginData.account.username,
        session_token: loginData.token,
        serialized_session: loginData.serialized,
        instagram_pk: loginData.account.pk,
        avatar_url: loginData.account.avatar_url,
        created_at: Date.now(),
        last_sync: Date.now()
      })
    }
    setSession(session)
    navigate('/dashboard')
  }

  async function setupDemo() {
    if (!session) return
    const u = prompt('Nome de usuário para o modo demo:')
    if (!u?.trim()) return
    const clean = u.trim().toLowerCase()
    setLoading(true); setError('')
    try {
      const existing = await db.accounts.where('user_id').equals(session.userId).first()
      let accId: number
      if (existing) {
        accId = existing.id!
        await db.accounts.update(accId, { username: clean, last_sync: Date.now() })
      } else {
        accId = await db.accounts.add({
          user_id: session.userId, username: clean,
          session_token: `demo_${clean}_${Date.now()}`, created_at: Date.now()
        })
      }
      await initMockData(accId)
      setSession(session)
      navigate('/dashboard')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erro ao configurar')
    } finally { setLoading(false) }
  }

  async function handleCookieLogin(e: React.FormEvent) {
    e.preventDefault()
    const val = cookieValue.trim()
    if (!val) { setError('Cole o Session ID do Instagram'); return }
    setError(''); setLoading(true)
    try {
      const result = await api.cookieLogin(val)
      await finishSetup(result)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Session ID inválido')
    } finally { setLoading(false) }
  }

  return (
    <div className="login-page">
      <div className="login-box" style={{ maxWidth: 520 }}>
        <span className="login-logo">🔑</span>
        <h2 style={{ marginBottom: 8 }}>Conectar Instagram</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
          Cole o valor do <strong>sessionid</strong> copiado dos cookies do Instagram.
        </p>

        {/* Status do servidor */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', borderRadius: 8, marginBottom: 16, fontSize: 12,
          background: serverStatus === 'online' ? 'rgba(67,233,123,0.08)' : serverStatus === 'offline' ? 'rgba(246,79,89,0.08)' : 'rgba(255,255,255,0.04)',
          border: `1px solid ${serverStatus === 'online' ? 'rgba(67,233,123,0.3)' : serverStatus === 'offline' ? 'rgba(246,79,89,0.3)' : 'rgba(255,255,255,0.1)'}`,
        }}>
          <span>{serverStatus === 'online' ? '🟢' : serverStatus === 'offline' ? '🔴' : '⏳'}</span>
          <span style={{ color: serverStatus === 'online' ? 'var(--accent-green)' : serverStatus === 'offline' ? 'var(--accent-pink)' : 'var(--text-muted)' }}>
            {serverStatus === 'online' ? 'Servidor online' : serverStatus === 'offline' ? 'Servidor offline — execute: cd server && node index.js' : 'Verificando...'}
          </span>
        </div>

        {error && <div className="error-msg" style={{ whiteSpace: 'pre-wrap', textAlign: 'left' }}>⚠️ {error}</div>}

        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '14px 16px', marginBottom: 12, textAlign: 'left' }}>
          <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Passo 1 — Abrir o Instagram</p>
          <button type="button" className="btn btn-primary" style={{ width: '100%' }}
            onClick={() => window.open('https://www.instagram.com/', '_blank', 'width=500,height=700')}>
            🔓 Abrir Instagram
          </button>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            Faça login normalmente no site (se ainda não estiver logado).
          </p>
        </div>

        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '14px 16px', marginBottom: 12, textAlign: 'left' }}>
          <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Passo 2 — Copiar o Session ID</p>
          <ol style={{ fontSize: 12, color: 'var(--text-muted)', paddingLeft: 18, lineHeight: 2.2, margin: 0 }}>
            <li>No Instagram logado, pressione <kbd style={{ background: 'rgba(255,255,255,0.1)', padding: '1px 5px', borderRadius: 3, fontFamily: 'monospace' }}>F12</kbd></li>
            <li>Vá na aba <strong style={{ color: 'var(--text-secondary)' }}>Application</strong> (Aplicação)</li>
            <li>No menu esquerdo: <strong style={{ color: 'var(--text-secondary)' }}>Cookies</strong> → <strong style={{ color: 'var(--text-secondary)' }}>https://www.instagram.com</strong></li>
            <li>Encontre <strong style={{ color: 'var(--accent-blue)' }}>sessionid</strong> na lista</li>
            <li>Clique duas vezes no <strong style={{ color: 'var(--accent-green)' }}>valor</strong> → copie (Ctrl+C)</li>
          </ol>
          <div style={{ marginTop: 10, padding: '8px 10px', background: 'rgba(102,126,234,0.1)', borderRadius: 6, fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
            Exemplo: 1234567890%3AaBcDeFgHiJ%3A8%3AAYabcdef...
          </div>
        </div>

        <form onSubmit={handleCookieLogin}>
          <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '14px 16px', marginBottom: 16, textAlign: 'left' }}>
            <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Passo 3 — Colar aqui</p>
            <input className="form-input" type="text" placeholder="Cole o valor do sessionid aqui..."
              value={cookieValue} onChange={e => setCookieValue(e.target.value)}
              style={{ fontFamily: 'monospace', fontSize: 12 }} autoFocus />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              Apenas o valor do sessionid. Não precisa copiar nenhum outro cookie.
            </p>
          </div>
          <button className="login-btn" type="submit" disabled={loading || !cookieValue.trim() || serverStatus === 'offline'}>
            {loading ? '⏳ Verificando...' : '✅ Conectar com Instagram'}
          </button>
        </form>

        <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px solid var(--border-color)', textAlign: 'center' }}>
          <button type="button" onClick={setupDemo}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}>
            Entrar em modo demo (dados simulados)
          </button>
        </div>
      </div>
    </div>
  )
}
