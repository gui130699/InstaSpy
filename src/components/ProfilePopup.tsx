import { useEffect, useState, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { useProfilePopup } from '../context/ProfilePopupContext'
import { api, proxyAvatarUrl, type ProfileSummary } from '../services/apiClient'
import { db } from '../db/database'

export default function ProfilePopup() {
  const { state, closeProfile } = useProfilePopup()
  const { accountId } = useAuth()
  const [profile, setProfile] = useState<ProfileSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [added, setAdded] = useState(false)
  const [adding, setAdding] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)

  // Reset ao abrir novo perfil
  useEffect(() => {
    if (!state.open || !state.username) return
    setProfile(null)
    setError('')
    setAdded(false)
    setLoading(true)

    async function load() {
      try {
        const acc = await db.accounts.get(accountId!)
        if (!acc?.session_token) throw new Error('Sem sessão ativa')
        const data = await api.fetchProfile(state.username!, acc.session_token)
        setProfile(data)
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Erro ao carregar perfil')
      } finally {
        setLoading(false)
      }
    }

    if (accountId) load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.username, state.open])

  // Fecha ao clicar no overlay
  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) closeProfile()
  }

  // Fecha com Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') closeProfile() }
    if (state.open) document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [state.open, closeProfile])

  async function handleAddMonitored() {
    if (!state.username || adding || added) return
    try {
      setAdding(true)
      const { session } = await import('../context/AuthContext').then(m => {
        // get session from db instead
        return { session: null }
      })
      // Obter user_id a partir da conta ativa
      const acc = accountId ? await db.accounts.get(accountId) : null
      if (!acc) throw new Error('Conta não encontrada')
      const userId = acc.user_id

      const exists = await db.monitored_profiles
        .where('user_id').equals(userId)
        .and(p => p.username === state.username)
        .first()
      if (!exists) {
        await db.monitored_profiles.add({
          user_id: userId,
          username: state.username!,
          avatar_url: profile?.avatar_url || '',
          added_at: Date.now(),
        })
      }
      setAdded(true)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Erro ao adicionar')
    } finally {
      setAdding(false)
    }
  }

  if (!state.open) return null

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(6px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 16,
        width: '100%',
        maxWidth: 340,
        padding: 24,
        position: 'relative',
        boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
      }}>
        {/* Botão fechar */}
        <button
          onClick={closeProfile}
          style={{
            position: 'absolute', top: 12, right: 12,
            background: 'rgba(255,255,255,0.08)',
            border: 'none', borderRadius: 8,
            width: 28, height: 28, cursor: 'pointer',
            color: 'var(--text-muted)', fontSize: 14,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >✕</button>

        {loading && (
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: 13 }}>
            <div className="spinner" style={{ margin: '0 auto 12px' }} />
            Carregando perfil...
          </div>
        )}

        {error && !loading && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>⚠️</div>
            <div style={{ fontSize: 13, color: 'var(--accent-pink)' }}>{error}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>@{state.username}</div>
          </div>
        )}

        {profile && !loading && (
          <>
            {/* Avatar */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 20 }}>
              {profile.avatar_url ? (
                <img
                  src={proxyAvatarUrl(profile.avatar_url)}
                  alt={profile.username}
                  style={{
                    width: 80, height: 80, borderRadius: '50%',
                    objectFit: 'cover',
                    border: '2px solid var(--border-color)',
                    marginBottom: 12,
                  }}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none'
                    const fallback = e.currentTarget.nextElementSibling as HTMLElement
                    if (fallback) fallback.style.display = 'flex'
                  }}
                />
              ) : null}
              {/* Fallback inicial */}
              <div style={{
                width: 80, height: 80, borderRadius: '50%',
                background: 'linear-gradient(135deg, #667eea, #764ba2)',
                display: profile.avatar_url ? 'none' : 'flex',
                alignItems: 'center', justifyContent: 'center',
                fontSize: 28, fontWeight: 700, color: '#fff',
                marginBottom: 12,
              }}>
                {profile.username.charAt(0).toUpperCase()}
              </div>

              <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>
                @{profile.username}
              </div>
              {profile.limited && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, textAlign: 'center' }}>
                  Perfil privado — dados de contagem indisponíveis
                </div>
              )}
            </div>

            {/* Contagens */}
            {!profile.limited && (
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 12, marginBottom: 20,
              }}>
                {([
                  { label: 'Seguidores', value: profile.followers_count, icon: '👥' },
                  { label: 'Seguindo',   value: profile.following_count, icon: '🔵' },
                  { label: 'Posts',      value: profile.posts_count,     icon: '📷' },
                ] as const).map(({ label, value, icon }) => (
                  <div key={label} style={{
                    textAlign: 'center',
                    background: 'rgba(255,255,255,0.04)',
                    borderRadius: 10, padding: '10px 4px',
                    border: '1px solid var(--border-color)',
                  }}>
                    <div style={{ fontSize: 16 }}>{icon}</div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', marginTop: 2 }}>
                      {value.toLocaleString('pt-BR')}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>{label}</div>
                  </div>
                ))}
              </div>
            )}
            {profile.limited && <div style={{ marginBottom: 20 }} />}

            {/* Botão adicionar ao monitoramento */}
            <button
              onClick={handleAddMonitored}
              disabled={adding || added}
              style={{
                width: '100%',
                padding: '10px 0',
                borderRadius: 10,
                border: 'none',
                cursor: adding || added ? 'default' : 'pointer',
                fontWeight: 600, fontSize: 13,
                background: added
                  ? 'rgba(67,233,123,0.15)'
                  : 'linear-gradient(135deg, #667eea, #764ba2)',
                color: added ? 'var(--accent-green)' : '#fff',
                transition: 'opacity 0.2s',
                opacity: adding ? 0.7 : 1,
              }}
            >
              {added ? '✅ Adicionado ao monitoramento' : adding ? '⏳ Adicionando...' : '🔍 Adicionar ao monitoramento'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
