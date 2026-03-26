import { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { db, type Alert } from '../db/database'
import { formatDateTime } from '../utils/formatters'

const ICONS: Record<Alert['type'], string> = {
  new_follower: '🟢',
  lost_follower: '🔴',
  new_following: '🔵',
  lost_following: '⚪',
  new_post: '📷',
  new_like: '👍',
  lost_like: '👎',
  profile_growth: '📈',
  profile_decline: '📉'
}

const LABELS: Record<Alert['type'], string> = {
  new_follower: 'Novo seguidor',
  lost_follower: 'Seguidor perdido',
  new_following: 'Novo seguindo',
  lost_following: 'Deixou de seguir',
  new_post: 'Novo post',
  new_like: 'Nova curtida',
  lost_like: 'Descurtida',
  profile_growth: 'Crescimento',
  profile_decline: 'Queda'
}

export default function AlertsPage() {
  const { accountId } = useAuth()
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [filter, setFilter] = useState<Alert['type'] | 'all'>('all')
  const [unreadCount, setUnreadCount] = useState(0)

  useEffect(() => {
    if (!accountId) return
    loadAlerts()
  }, [accountId, filter])

  async function loadAlerts() {
    if (!accountId) return
    const allRaw = await db.alerts.where('account_id').equals(accountId).toArray()
    const all = allRaw.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100)
    setUnreadCount(all.filter(a => !a.read).length)

    const filtered = filter === 'all' ? all : all.filter(a => a.type === filter)
    setAlerts(filtered)
  }

  async function markAllRead() {
    if (!accountId) return
    const unread = await db.alerts
      .where('account_id').equals(accountId)
      .and(a => !a.read)
      .toArray()
    await Promise.all(unread.map(a => db.alerts.update(a.id!, { read: true })))
    await loadAlerts()
  }

  async function clearAll() {
    if (!accountId) return
    await db.alerts.where('account_id').equals(accountId).delete()
    await loadAlerts()
  }

  const filterTypes: Array<Alert['type'] | 'all'> = [
    'all', 'new_follower', 'lost_follower', 'new_like', 'lost_like', 'new_post'
  ]

  return (
    <>
      <div className="topbar">
        <h1 className="topbar-title">🔔 Alertas</h1>
        <div className="topbar-actions">
          {unreadCount > 0 && (
            <span className="badge badge-info">{unreadCount} não lidos</span>
          )}
          <button className="btn btn-outline btn-sm" onClick={markAllRead}>
            ✅ Marcar todos como lidos
          </button>
          <button className="btn btn-outline btn-sm" onClick={clearAll}
            style={{ color: 'var(--accent-pink)', borderColor: 'var(--accent-pink)' }}>
            🗑 Limpar
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        {filterTypes.map(f => (
          <button
            key={f}
            className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'Todos' : (ICONS[f as Alert['type']] + ' ' + LABELS[f as Alert['type']])}
          </button>
        ))}
      </div>

      <div className="card">
        {alerts.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">🔔</span>
            <p>Nenhum alerta encontrado. Faça uma coleta no Dashboard.</p>
          </div>
        ) : (
          <ul className="timeline-list">
            {alerts.map(a => (
              <li
                key={a.id}
                className={`timeline-item ${!a.read ? 'unread' : ''}`}
                style={{ cursor: 'default' }}
                onClick={() => {
                  if (!a.read) db.alerts.update(a.id!, { read: true }).then(loadAlerts)
                }}
              >
                <span className="timeline-icon">{ICONS[a.type]}</span>
                <div className="timeline-content">
                  <div className="timeline-message">{a.message}</div>
                  <div className="timeline-time">
                    {formatDateTime(a.timestamp)}
                    {!a.read && <span className="badge badge-info" style={{ marginLeft: 8 }}>Novo</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
