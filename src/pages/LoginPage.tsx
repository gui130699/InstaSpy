import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { login, register } from '../services/authService'
import { useAuth } from '../context/AuthContext'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const navigate = useNavigate()
  const { setSession } = useAuth()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      let session
      try {
        session = await login(email, senha)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : ''
        if (msg === 'Usuário não encontrado') {
          // Primeiro acesso: cria conta automaticamente
          await register(email, senha, email.split('@')[0])
          session = await login(email, senha)
        } else {
          throw err
        }
      }
      setSession(session)
      navigate('/setup')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erro desconhecido')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-box">
        <div className="login-header">
          <span className="login-logo">📊</span>
          <h2>InstaMonitor</h2>
          <p>Monitoramento inteligente do seu Instagram</p>
        </div>

        {error && <div className="error-msg">⚠️ {error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">E-mail</label>
            <input
              className="form-input"
              type="email"
              placeholder="seu@email.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">Senha</label>
            <input
              className="form-input"
              type="password"
              placeholder="••••••••"
              value={senha}
              onChange={e => setSenha(e.target.value)}
              required
              minLength={6}
            />
          </div>

          <button className="login-btn" type="submit" disabled={loading}>
            {loading ? '⏳ Aguarde...' : '🚀 Entrar'}
          </button>

          <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
            Primeiro acesso? A conta será criada automaticamente.
          </p>
        </form>
      </div>
    </div>
  )
}

