import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { db, type MonitoredProfile, type MonitoredSnapshot } from '../db/database'
import { initMockMonitoredData } from '../services/mockCollector'
import { formatRelativeTime } from '../utils/formatters'

export default function MonitoredPage() {
  const { session } = useAuth()
  const navigate = useNavigate()
  const [profiles, setProfiles] = useState<MonitoredProfile[]>([])
  const [snapMap, setSnapMap] = useState<Map<number, MonitoredSnapshot>>(new Map())
  const [newUsername, setNewUsername] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!session) return
    loadProfiles()
  }, [session])

  async function loadProfiles() {
    if (!session) return
    const profs = await db.monitored_profiles
      .where('user_id').equals(session.userId)
      .toArray()
    setProfiles(profs)

    const map = new Map<number, MonitoredSnapshot>()
    for (const p of profs) {
      const monSnaps = await db.monitored_snapshots.where('profile_id').equals(p.id!).toArray()
      const snap = monSnaps.sort((a, b) => b.timestamp - a.timestamp)[0]
      if (snap) map.set(p.id!, snap)
    }
    setSnapMap(map)
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!session) return
    setError('')
    setAdding(true)

    try {
      const clean = newUsername.replace('@', '').trim().toLowerCase()
      if (!clean) throw new Error('Informe um username válido')

      const exists = await db.monitored_profiles
        .where('user_id').equals(session.userId)
        .and(p => p.username === clean)
        .first()
      if (exists) throw new Error('Perfil já monitorado')

      const profId = await db.monitored_profiles.add({
        user_id: session.userId,
        username: clean,
        added_at: Date.now()
      })

      // Gerar dados mock completos (seguidores, posts, curtidas)
      await initMockMonitoredData(profId)

      setNewUsername('')
      await loadProfiles()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erro ao adicionar')
    } finally {
      setAdding(false)
    }
  }

  async function handleRemove(profileId: number) {
    await db.monitored_profiles.delete(profileId)
    await db.monitored_snapshots.where('profile_id').equals(profileId).delete()
    await db.monitored_posts.where('profile_id').equals(profileId).delete()
    await db.monitored_post_snapshots.where('profile_id').equals(profileId).delete()
    await loadProfiles()
  }

  return (
    <>
      <div className="topbar">
        <h1 className="topbar-title">🔍 Perfis Monitorados</h1>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {profiles.length} perfil(is)
        </span>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <span className="card-title">Adicionar perfil</span>
        </div>
        {error && <div className="error-msg">⚠️ {error}</div>}
        <form onSubmit={handleAdd} style={{ display: 'flex', gap: 12 }}>
          <input
            className="form-input"
            type="text"
            placeholder="@nomeusuario"
            value={newUsername}
            onChange={e => setNewUsername(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn btn-primary" type="submit" disabled={adding}>
            {adding ? '⏳' : '+ Adicionar'}
          </button>
        </form>
      </div>

      {profiles.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">🔍</span>
          <p>Nenhum perfil monitorado ainda. Adicione um acima.</p>
        </div>
      ) : (
        <div className="posts-grid">
          {profiles.map(p => {
            const snap = snapMap.get(p.id!)
            return (
              <div key={p.id} className="card" style={{ cursor: 'pointer' }} onClick={() => navigate(`/monitored/${p.id}`)}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div className="user-avatar">
                      {p.username.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>@{p.username}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        Adicionado {formatRelativeTime(p.added_at)}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }} onClick={e => e.stopPropagation()}>
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => navigate(`/monitored/${p.id}`)}
                    >
                      🔍 Detalhes
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => handleRemove(p.id!)}
                    >
                      🗑
                    </button>
                  </div>
                </div>

                {snap && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontWeight: 700, fontSize: 20 }}>{snap.followers_count.toLocaleString('pt-BR')}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Seguidores</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontWeight: 700, fontSize: 20 }}>{snap.following_count.toLocaleString('pt-BR')}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Seguindo</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontWeight: 700, fontSize: 20 }}>{snap.posts_count}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Posts</div>
                    </div>
                  </div>
                )}

                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--accent-primary)' }}>Clique para ver seguidores, posts e curtidas →</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
