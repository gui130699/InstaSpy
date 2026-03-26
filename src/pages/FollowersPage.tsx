import { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { getSnapshotHistory, compareSnapshots } from '../services/snapshotService'
import UserChip from '../components/UserChip'
import type { Snapshot } from '../db/database'

export default function FollowersPage() {
  const { accountId } = useAuth()
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [tab, setTab] = useState<'ganhos' | 'perdidos' | 'todos'>('todos')
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!accountId) return
    getSnapshotHistory(accountId, 30).then(setSnapshots)
  }, [accountId])

  const latest = snapshots[0]
  const previous = snapshots[1]
  const diff = latest && previous ? compareSnapshots(previous, latest) : null

  const displayList = () => {
    if (!latest) return []
    if (tab === 'todos') return latest.followers_list
    if (tab === 'ganhos') return diff?.newFollowers ?? []
    return diff?.lostFollowers ?? []
  }

  const list = displayList().filter(u =>
    !search || u.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <>
      <div className="topbar">
        <h1 className="topbar-title">👥 Seguidores</h1>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {latest?.followers_count ?? 0} total
        </span>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 24 }}>
        <div className="card" style={{ cursor: 'pointer', border: tab === 'todos' ? '1px solid var(--accent-primary)' : undefined }} onClick={() => setTab('todos')}>
          <div className="card-title">Todos</div>
          <div className="card-value">{latest?.followers_count ?? 0}</div>
        </div>
        <div className="card" style={{ cursor: 'pointer', border: tab === 'ganhos' ? '1px solid var(--accent-green)' : undefined }} onClick={() => setTab('ganhos')}>
          <div className="card-title">Novos</div>
          <div className="card-value" style={{ color: 'var(--accent-green)' }}>
            +{diff?.newFollowers.length ?? 0}
          </div>
        </div>
        <div className="card" style={{ cursor: 'pointer', border: tab === 'perdidos' ? '1px solid var(--accent-pink)' : undefined }} onClick={() => setTab('perdidos')}>
          <div className="card-title">Perdidos</div>
          <div className="card-value" style={{ color: 'var(--accent-pink)' }}>
            -{diff?.lostFollowers.length ?? 0}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">
            {tab === 'todos' && 'Lista de seguidores'}
            {tab === 'ganhos' && '🟢 Novos seguidores'}
            {tab === 'perdidos' && '🔴 Seguidores perdidos'}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{list.length} usuário(s)</span>
        </div>
        <input
          type="text"
          placeholder="🔍 Buscar usuário..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', marginBottom: 12, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' }}
        />

        {list.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">
              {tab === 'ganhos' ? '🟢' : tab === 'perdidos' ? '🔴' : '👥'}
            </span>
            <p>
              {tab === 'ganhos' && 'Nenhum novo seguidor nesta coleta'}
              {tab === 'perdidos' && 'Nenhum seguidor perdido nesta coleta'}
              {tab === 'todos' && 'Nenhum dado ainda. Faça uma coleta no Dashboard.'}
            </p>
          </div>
        ) : (
          <ul className="user-list">
            {list.map(username => (
              <UserChip
                key={username}
                username={username}
                badge={
                  tab === 'ganhos'
                    ? <span className="badge badge-success">Novo</span>
                    : tab === 'perdidos'
                      ? <span className="badge badge-danger">Saiu</span>
                      : undefined
                }
              />
            ))}
          </ul>
        )}
      </div>

      {snapshots.length >= 2 && (
        <div className="card" style={{ marginTop: 20 }}>
          <div className="card-header">
            <span className="card-title">Seguindo</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                🔵 Novos seguindo ({diff?.newFollowing.length ?? 0})
              </div>
              {diff?.newFollowing.map(u => (
                <UserChip key={u} username={u} />
              ))}
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                ⚪ Deixou de seguir ({diff?.lostFollowing.length ?? 0})
              </div>
              {diff?.lostFollowing.map(u => (
                <UserChip key={u} username={u} />
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
