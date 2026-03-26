import { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { getSnapshotHistory, compareSnapshots } from '../services/snapshotService'
import UserChip from '../components/UserChip'
import type { Snapshot } from '../db/database'

export default function FollowingPage() {
  const { accountId } = useAuth()
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [tab, setTab] = useState<'todos' | 'novos' | 'deixou'>('todos')
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
    if (tab === 'todos') return latest.following_list
    if (tab === 'novos') return diff?.newFollowing ?? []
    return diff?.lostFollowing ?? []
  }

  const list = displayList().filter(u =>
    !search || u.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <>
      <div className="topbar">
        <h1 className="topbar-title">➡️ Seguindo</h1>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {latest?.following_count ?? 0} total
        </span>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 24 }}>
        <div
          className="card"
          style={{ cursor: 'pointer', border: tab === 'todos' ? '1px solid var(--accent-primary)' : undefined }}
          onClick={() => setTab('todos')}
        >
          <div className="card-title">Todos</div>
          <div className="card-value">{latest?.following_count ?? 0}</div>
        </div>
        <div
          className="card"
          style={{ cursor: 'pointer', border: tab === 'novos' ? '1px solid var(--accent-green)' : undefined }}
          onClick={() => setTab('novos')}
        >
          <div className="card-title">Novos</div>
          <div className="card-value" style={{ color: 'var(--accent-green)' }}>
            +{diff?.newFollowing.length ?? 0}
          </div>
        </div>
        <div
          className="card"
          style={{ cursor: 'pointer', border: tab === 'deixou' ? '1px solid var(--accent-pink)' : undefined }}
          onClick={() => setTab('deixou')}
        >
          <div className="card-title">Deixou de seguir</div>
          <div className="card-value" style={{ color: 'var(--accent-pink)' }}>
            -{diff?.lostFollowing.length ?? 0}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">
            {tab === 'todos' && 'Lista de seguindo'}
            {tab === 'novos' && '🔵 Começou a seguir'}
            {tab === 'deixou' && '⚪ Deixou de seguir'}
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
              {tab === 'novos' ? '🔵' : tab === 'deixou' ? '⚪' : '➡️'}
            </span>
            <p>
              {tab === 'novos' && 'Nenhum novo seguindo nesta coleta'}
              {tab === 'deixou' && 'Nenhuma conta deixada de seguir'}
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
                  tab === 'novos'
                    ? <span className="badge badge-info">Novo</span>
                    : tab === 'deixou'
                      ? <span className="badge badge-danger">Saiu</span>
                      : undefined
                }
              />
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
