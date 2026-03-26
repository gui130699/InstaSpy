import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { db } from '../db/database'
import { getSnapshotHistory } from '../services/snapshotService'
import { runMockCollection } from '../services/mockCollector'
import { runRealCollection } from '../services/realCollector'
import { api } from '../services/apiClient'
import { formatRelativeTime, formatDateTime } from '../utils/formatters'
import type { Alert, Snapshot } from '../db/database'

function alertIcon(type: Alert['type']): string {
  const map: Record<Alert['type'], string> = {
    new_follower: '🟢', lost_follower: '🔴',
    new_following: '🔵', lost_following: '⚪',
    new_post: '📷', new_like: '👍', lost_like: '👎',
    profile_growth: '📈', profile_decline: '📉'
  }
  return map[type] ?? '📌'
}

export default function DashboardPage() {
  const { accountId, session } = useAuth()
  const navigate = useNavigate()

  const [account, setAccount] = useState<{ username: string; last_sync?: number; isReal?: boolean } | null>(null)
  const [latest, setLatest] = useState<Snapshot | null>(null)
  const [previous, setPrevious] = useState<Snapshot | null>(null)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [collecting, setCollecting] = useState(false)
  const [collectionMsg, setCollectionMsg] = useState('')
  const [collectProgress, setCollectProgress] = useState<{ step: string; message: string; pct: number; latestUsers?: string[] } | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [collectModes, setCollectModes] = useState<Set<string>>(new Set(['followers', 'following', 'posts']))

  function toggleMode(m: string) {
    setCollectModes(prev => {
      const next = new Set(prev)
      if (next.has(m)) {
        if (next.size > 1) next.delete(m)
      } else {
        next.add(m)
      }
      return next
    })
  }

  const loadData = useCallback(async () => {
    if (!accountId) return

    const acc = await db.accounts.get(accountId)
    setAccount(acc ? {
      username: acc.username,
      last_sync: acc.last_sync,
      isReal: !!acc.serialized_session
    } : null)

    const history = await getSnapshotHistory(accountId, 2)
    setLatest(history[0] ?? null)
    setPrevious(history[1] ?? null)

    const allAlerts = await db.alerts.where('account_id').equals(accountId).toArray()
    allAlerts.sort((a, b) => b.timestamp - a.timestamp)
    setAlerts(allAlerts.slice(0, 10))
  }, [accountId])

  useEffect(() => {
    if (!accountId) {
      navigate('/setup')
      return
    }
    loadData()
  }, [accountId, loadData, navigate])

  // Polling do progresso enquanto coleta está em andamento
  useEffect(() => {
    if (!collecting || !accountId) {
      if (!collecting) setCollectProgress(null)
      return
    }
    const interval = setInterval(async () => {
      const acc = await db.accounts.get(accountId)
      if (!acc?.session_token) return
      try {
        const p = await api.getCollectProgress(acc.session_token)
        if (p.active && p.step) {
          setCollectProgress({ step: p.step, message: p.message ?? '', pct: p.pct ?? 0, latestUsers: p.latestUsers })
        }
      } catch { /* ignora erros de polling */ }
    }, 2000)
    return () => clearInterval(interval)
  }, [collecting, accountId])

  async function handleCollect() {
    if (!accountId || collecting) return
    setCollecting(true)
    setCollectionMsg('')

    try {
      const acc = await db.accounts.get(accountId)
      const isReal = !!acc?.serialized_session

      if (isReal) {
        const modeParam = [...collectModes].join(',')
        const realResult = await runRealCollection(accountId, modeParam)
        if (realResult.partial || realResult.skipped.length > 0) {
          const a = realResult.account
          const blockedSections = realResult.skipped.length === 0
            ? ['listas']
            : realResult.skipped.map(s =>
                s === 'followers' ? 'seguidores' : s === 'following' ? 'seguindo' : 'posts'
              )
          const wasBlocked = realResult.partial
          const prefix = wasBlocked ? '⚠️ Bloqueado' : '⚡ Parcial'
          const detail = wasBlocked
            ? `Instagram bloqueou temporariamente. `
            : `Seções não selecionadas: ${blockedSections.join(', ')}. `
          setCollectionMsg(
            `${prefix} — ${detail}` +
            `Contagens salvas: ${a.followers_count} seg · ${a.following_count} snd · ${a.posts_count} posts.`
          )
        } else {
          const total =
            realResult.followersDiff.newFollowers.length +
            realResult.followersDiff.lostFollowers.length +
            realResult.likerDiffs.reduce((a, d) => a + d.newLikers.length + d.lostLikers.length, 0)
          setCollectionMsg(`✅ Coleta concluída — ${total} evento(s) registrado(s)`)
        }
      } else {
        const mockResult = await runMockCollection(accountId)
        const total =
          mockResult.followersDiff.newFollowers.length +
          mockResult.followersDiff.lostFollowers.length +
          mockResult.likerDiffs.reduce((a, d) => a + d.newLikers.length + d.lostLikers.length, 0)
        setCollectionMsg(`✅ Coleta concluída — ${total} evento(s) registrado(s)`)
      }
      await loadData()
      setRefreshKey(k => k + 1)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro na coleta'
      setCollectionMsg(`❌ ${msg}`)
    } finally {
      setCollecting(false)
    }
  }

  async function handleClear() {
    if (!accountId) return
    if (!window.confirm('Limpar todos os dados coletados desta conta?\n\nIsso apaga snapshots, posts e alertas. A próxima coleta será o primeiro snapshot.')) return
    await db.snapshots.where('account_id').equals(accountId).delete()
    await db.posts.where('account_id').equals(accountId).delete()
    await db.post_snapshots.where('account_id').equals(accountId).delete()
    await db.alerts.where('account_id').equals(accountId).delete()
    await db.accounts.update(accountId, { last_sync: undefined })
    setCollectionMsg('')
    await loadData()
    setRefreshKey(k => k + 1)
  }

  const followerDelta = latest && previous
    ? latest.followers_count - previous.followers_count
    : 0
  const followingDelta = latest && previous
    ? latest.following_count - previous.following_count
    : 0

  return (
    <>
      <div className="topbar">
        <h1 className="topbar-title">📊 Dashboard</h1>
        <div className="topbar-actions">
          {account && (
            <span style={{ fontSize: 13, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              @{account.username}
              {account.isReal !== undefined && (
                <span style={{
                  fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 600,
                  background: account.isReal ? 'rgba(67,233,123,0.15)' : 'rgba(102,126,234,0.15)',
                  color: account.isReal ? 'var(--accent-green)' : 'var(--accent-blue)',
                  border: `1px solid ${account.isReal ? 'rgba(67,233,123,0.3)' : 'rgba(102,126,234,0.3)'}`
                }}>
                  {account.isReal ? 'REAL' : 'DEMO'}
                </span>
              )}
              {account.last_sync && ` · ${formatRelativeTime(account.last_sync)}`}
            </span>
          )}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        {account?.isReal && (
          <>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginRight: 2 }}>Coletar:</span>
            {([
              { key: 'followers', label: '👥 Seguidores' },
              { key: 'following', label: '🔵 Seguindo' },
              { key: 'posts',     label: '📷 Posts' },
            ] as const).map(({ key, label }) => {
              const active = collectModes.has(key)
              return (
                <button
                  key={key}
                  onClick={() => !collecting && toggleMode(key)}
                  style={{
                    fontSize: 11, padding: '3px 9px', borderRadius: 12, cursor: collecting ? 'default' : 'pointer',
                    background: active ? 'rgba(102,126,234,0.18)' : 'transparent',
                    border: active ? '1px solid rgba(102,126,234,0.45)' : '1px solid rgba(255,255,255,0.1)',
                    color: active ? 'var(--accent-blue)' : 'var(--text-muted)',
                    fontWeight: active ? 700 : 400,
                    opacity: collecting ? 0.5 : 1,
                    transition: 'all 0.18s ease',
                  }}
                >
                  {label}
                </button>
              )
            })}
          </>
        )}
        <button
          className="btn btn-primary btn-sm"
          onClick={handleCollect}
          disabled={collecting}
        >
          {collecting ? '⏳ Coletando...' : '🔄 Coletar agora'}
        </button>
        {!collecting && (latest || previous) && (
          <button
            className="btn btn-outline btn-sm"
            onClick={handleClear}
            style={{ color: 'var(--accent-pink)', borderColor: 'rgba(246,79,89,0.3)' }}
          >
            🗑️ Limpar dados
          </button>
        )}
      </div>
        </div>
      </div>

      {collecting && (
        <div style={{
          background: 'rgba(102,126,234,0.08)',
          border: '1px solid rgba(102,126,234,0.2)',
          borderRadius: 12,
          padding: '14px 16px',
          marginBottom: 16,
        }}>
          {/* Cabeçalho com mensagem e percentual */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent-blue)' }}>
              {collectProgress?.message ?? 'Iniciando coleta...'}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {collectProgress?.pct ?? 0}%
            </span>
          </div>
          {/* Barra de progresso animada */}
          <div style={{
            height: 6, background: 'rgba(255,255,255,0.1)',
            borderRadius: 3, overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${collectProgress?.pct ?? 5}%`,
              background: 'linear-gradient(90deg, #667eea, #764ba2)',
              borderRadius: 3,
              transition: 'width 0.6s ease',
            }} />
          </div>
          {/* Etapas */}
          <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
            {([
              { key: 'cookies',        icon: '🔑', label: 'Sessão',     threshold: 12 },
              { key: 'followers',      icon: '👥', label: 'Seguidores', threshold: 45 },
              { key: 'following',      icon: '🔵', label: 'Seguindo',   threshold: 75 },
              { key: 'posts',          icon: '📷', label: 'Posts',      threshold: 88 },
              { key: 'likers',         icon: '👍', label: 'Curtidas',   threshold: 95 },
            ] as const).map(s => {
              const pct = collectProgress?.pct ?? 0
              const done = pct >= s.threshold
              const active = !done && pct >= (s.threshold - 35)
              return (
                <div key={s.key} style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  fontSize: 11, fontWeight: done || active ? 600 : 400,
                  opacity: done ? 1 : active ? 0.9 : 0.4,
                  color: done ? 'var(--accent-green)' : active ? 'var(--accent-blue)' : 'var(--text-muted)',
                  transition: 'all 0.3s ease',
                }}>
                  {s.icon} {s.label} {done && '✓'}
                </div>
              )
            })}
          </div>

          {/* Feed de usuários em tempo real */}
          {collectProgress?.latestUsers && collectProgress.latestUsers.length > 0 && (
            <div style={{
              marginTop: 12,
              borderTop: '1px solid rgba(102,126,234,0.15)',
              paddingTop: 10,
            }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
                Lendo agora
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {collectProgress.latestUsers.map((u, i) => (
                  <span key={`${u}-${i}`} style={{
                    fontSize: 12,
                    padding: '3px 8px',
                    borderRadius: 20,
                    background: i === 0 ? 'rgba(102,126,234,0.2)' : 'rgba(255,255,255,0.05)',
                    border: i === 0 ? '1px solid rgba(102,126,234,0.4)' : '1px solid rgba(255,255,255,0.08)',
                    color: i === 0 ? 'var(--accent-blue)' : 'var(--text-muted)',
                    fontWeight: i === 0 ? 600 : 400,
                    transition: 'all 0.3s ease',
                  }}>
                    @{u}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {collectionMsg && (
        <div style={{
          padding: '10px 14px',
          background: collectionMsg.startsWith('✅') ? 'rgba(67,233,123,0.1)' : 'rgba(246,79,89,0.1)',
          border: `1px solid ${collectionMsg.startsWith('✅') ? 'rgba(67,233,123,0.3)' : 'rgba(246,79,89,0.3)'}`,
          borderRadius: 8,
          fontSize: 13,
          color: collectionMsg.startsWith('✅') ? 'var(--accent-green)' : 'var(--accent-pink)',
          marginBottom: 20
        }}>
          {collectionMsg}
        </div>
      )}

      {latest && !previous && !collecting && (
        <div style={{
          padding: '10px 14px',
          background: 'rgba(102,126,234,0.08)',
          border: '1px solid rgba(102,126,234,0.25)',
          borderRadius: 8, fontSize: 13,
          color: 'var(--accent-blue)',
          marginBottom: 16,
        }}>
          📊 <strong>Primeiro snapshot salvo!</strong> Colete novamente para comparar seguidores, seguindo e posts.
        </div>
      )}

      {latest && previous && !collecting && (
        <div style={{
          padding: '8px 14px',
          background: 'rgba(67,233,123,0.06)',
          border: '1px solid rgba(67,233,123,0.2)',
          borderRadius: 8, fontSize: 12,
          color: 'var(--text-muted)',
          marginBottom: 16,
        }}>
          📈 Comparando com coleta de {formatRelativeTime(previous.timestamp)}
        </div>
      )}

      <div className="stats-grid">
        <div className="card">
          <div className="card-header">
            <span className="card-title">Seguidores</span>
            <span className="card-icon">👥</span>
          </div>
          <div className="card-value">{latest?.followers_count ?? '—'}</div>
          {followerDelta !== 0 && (
            <div className={`card-delta ${followerDelta > 0 ? 'positive' : 'negative'}`}>
              {followerDelta > 0 ? '▲' : '▼'} {Math.abs(followerDelta)} desde última coleta
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">Seguindo</span>
            <span className="card-icon">🔵</span>
          </div>
          <div className="card-value">{latest?.following_count ?? '—'}</div>
          {followingDelta !== 0 && (
            <div className={`card-delta ${followingDelta > 0 ? 'positive' : 'negative'}`}>
              {followingDelta > 0 ? '▲' : '▼'} {Math.abs(followingDelta)} desde última coleta
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">Posts</span>
            <span className="card-icon">📷</span>
          </div>
          <PostCount accountId={accountId} key={refreshKey} />
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">Alertas hoje</span>
            <span className="card-icon">🔔</span>
          </div>
          <div className="card-value">{alerts.filter(a => !a.read).length}</div>
          <div className="card-delta" style={{ color: 'var(--text-muted)' }}>não lidos</div>
        </div>
      </div>

      <div className="content-grid">
        <div className="card">
          <div className="card-header">
            <span className="card-title">Timeline recente</span>
            <button className="btn btn-outline btn-sm" onClick={() => navigate('/alerts')}>
              Ver todos
            </button>
          </div>
          {alerts.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">🔔</span>
              <p>Nenhum alerta ainda. Clique em "Coletar agora".</p>
            </div>
          ) : (
            <ul className="timeline-list">
              {alerts.map(a => (
                <li key={a.id} className={`timeline-item ${!a.read ? 'unread' : ''}`}>
                  <span className="timeline-icon">{alertIcon(a.type)}</span>
                  <div className="timeline-content">
                    <div className="timeline-message">{a.message}</div>
                    <div className="timeline-time">{formatDateTime(a.timestamp)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">Sobre você</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Usuário do app</span>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{session?.nome}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Instagram</span>
              <span style={{ fontWeight: 600, fontSize: 13 }}>@{account?.username ?? '—'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Última coleta</span>
              <span style={{ fontWeight: 600, fontSize: 13 }}>
                {account?.last_sync ? formatRelativeTime(account.last_sync) : '—'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Snapshots salvos</span>
              <SnapshotCount accountId={accountId} key={refreshKey} />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function PostCount({ accountId }: { accountId: number | null }) {
  const [count, setCount] = useState<number>(0)
  useEffect(() => {
    if (!accountId) return
    db.posts.where('account_id').equals(accountId).count().then(setCount)
  }, [accountId])
  return <div className="card-value">{count}</div>
}

function SnapshotCount({ accountId }: { accountId: number | null }) {
  const [count, setCount] = useState<number>(0)
  useEffect(() => {
    if (!accountId) return
    db.snapshots.where('account_id').equals(accountId).count().then(setCount)
  }, [accountId])
  return <span style={{ fontWeight: 600, fontSize: 13 }}>{count}</span>
}
