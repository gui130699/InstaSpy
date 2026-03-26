import { useState, useEffect, useCallback } from 'react'
import { db, type MonitoredProfile } from '../db/database'
import { useAuth } from '../context/AuthContext'

type RankTab = 'perfil' | 'monitorados'

interface RankEntry {
  username: string
  count: number
}

function MedalIcon({ pos }: { pos: number }) {
  if (pos === 1) return <span style={{ fontSize: 20 }}>🥇</span>
  if (pos === 2) return <span style={{ fontSize: 20 }}>🥈</span>
  if (pos === 3) return <span style={{ fontSize: 20 }}>🥉</span>
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, borderRadius: '50%',
      background: 'rgba(255,255,255,0.08)',
      fontSize: 12, fontWeight: 700, color: 'var(--text-muted)',
      flexShrink: 0,
    }}>
      {pos}
    </span>
  )
}

function RankingList({ ranking, loading, emptyMsg }: {
  ranking: RankEntry[]
  loading: boolean
  emptyMsg: string
}) {
  if (loading) {
    return (
      <div className="loading" style={{ minHeight: 200 }}>
        <div className="spinner" />
        Calculando ranking...
      </div>
    )
  }
  if (ranking.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">🏆</span>
        <p>{emptyMsg}</p>
      </div>
    )
  }

  const max = ranking[0]?.count ?? 1

  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {ranking.map((entry, i) => {
        const pct = Math.round((entry.count / max) * 100)
        const isTop3 = i < 3
        return (
          <li
            key={entry.username}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 14px', borderRadius: 10,
              background: isTop3
                ? (i === 0 ? 'rgba(255,215,0,0.08)' : i === 1 ? 'rgba(192,192,192,0.08)' : 'rgba(205,127,50,0.08)')
                : 'rgba(255,255,255,0.03)',
              border: `1px solid ${isTop3
                ? (i === 0 ? 'rgba(255,215,0,0.25)' : i === 1 ? 'rgba(192,192,192,0.2)' : 'rgba(205,127,50,0.2)')
                : 'rgba(255,255,255,0.07)'}`,
            }}
          >
            <MedalIcon pos={i + 1} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
                  @{entry.username}
                </span>
                <span style={{
                  fontWeight: 700, fontSize: 13,
                  color: isTop3 ? 'var(--accent-blue)' : 'var(--text-secondary)',
                  flexShrink: 0, marginLeft: 8,
                }}>
                  {entry.count} {entry.count === 1 ? 'post curtido' : 'posts curtidos'}
                </span>
              </div>
              {/* Barra de progresso */}
              <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${pct}%`,
                  background: i === 0
                    ? 'linear-gradient(90deg, #ffd700, #ffb300)'
                    : i === 1
                    ? 'linear-gradient(90deg, #c0c0c0, #a8a8a8)'
                    : i === 2
                    ? 'linear-gradient(90deg, #cd7f32, #b8621e)'
                    : 'linear-gradient(90deg, #667eea, #764ba2)',
                  borderRadius: 2,
                }} />
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export default function RankingPage() {
  const { accountId, session } = useAuth()
  const [tab, setTab] = useState<RankTab>('perfil')

  // ── Meu perfil ──────────────────────────────────────────────────────────
  const [myRanking, setMyRanking] = useState<RankEntry[]>([])
  const [myLoading, setMyLoading] = useState(false)

  const loadMyRanking = useCallback(async () => {
    if (!accountId) return
    setMyLoading(true)
    try {
      const posts = await db.posts.where('account_id').equals(accountId).toArray()
      const counts = new Map<string, number>()
      for (const post of posts) {
        const snaps = await db.post_snapshots
          .where('post_id').equals(post.post_id)
          .sortBy('timestamp')
        const latest = snaps[snaps.length - 1]
        if (!latest?.likers_list?.length) continue
        for (const u of latest.likers_list) {
          counts.set(u, (counts.get(u) ?? 0) + 1)
        }
      }
      setMyRanking(
        Array.from(counts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([username, count]) => ({ username, count }))
      )
    } finally {
      setMyLoading(false)
    }
  }, [accountId])

  useEffect(() => { loadMyRanking() }, [loadMyRanking])

  // ── Monitorados ──────────────────────────────────────────────────────────
  const [monitoredProfiles, setMonitoredProfiles] = useState<MonitoredProfile[]>([])
  const [selectedProfile, setSelectedProfile] = useState<MonitoredProfile | null>(null)
  const [monRanking, setMonRanking] = useState<RankEntry[]>([])
  const [monLoading, setMonLoading] = useState(false)

  useEffect(() => {
    if (!session?.userId) return
    db.monitored_profiles.where('user_id').equals(session.userId).toArray()
      .then(setMonitoredProfiles)
  }, [session?.userId])

  async function loadMonitoredRanking(profile: MonitoredProfile) {
    if (selectedProfile?.id === profile.id) return
    setSelectedProfile(profile)
    setMonRanking([])
    setMonLoading(true)
    try {
      const posts = await db.monitored_posts.where('profile_id').equals(profile.id!).toArray()
      const counts = new Map<string, number>()
      for (const post of posts) {
        const snaps = await db.monitored_post_snapshots
          .where('post_id').equals(post.post_id)
          .sortBy('timestamp')
        const latest = snaps[snaps.length - 1]
        if (!latest?.likers_list?.length) continue
        for (const u of latest.likers_list) {
          counts.set(u, (counts.get(u) ?? 0) + 1)
        }
      }
      setMonRanking(
        Array.from(counts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([username, count]) => ({ username, count }))
      )
    } finally {
      setMonLoading(false)
    }
  }

  return (
    <div style={{ maxWidth: 700, margin: '0 auto' }}>
      {/* Topbar */}
      <div className="topbar" style={{ marginBottom: 24 }}>
        <h1 className="topbar-title">🏆 Ranking de Curtidas</h1>
      </div>

      {/* Tabs principais */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 24, background: 'var(--bg-secondary)', borderRadius: 8, padding: 4 }}>
        {([
          { key: 'perfil' as RankTab, label: '👤 Meu Perfil' },
          { key: 'monitorados' as RankTab, label: '🔍 Monitorados' },
        ]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              flex: 1, padding: '10px 8px', border: 'none', cursor: 'pointer',
              background: tab === key ? 'var(--accent-primary)' : 'transparent',
              color: tab === key ? '#fff' : 'var(--text-muted)',
              borderRadius: 6, fontWeight: tab === key ? 700 : 400,
              fontSize: 14, transition: 'all 0.2s', fontFamily: 'inherit',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ===== TAB: MEU PERFIL ===== */}
      {tab === 'perfil' && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                Top 20 — quem mais curtiu seus posts
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                Baseado nos curtidores da última coleta de cada post
              </div>
            </div>
            <button className="btn btn-outline btn-sm" onClick={loadMyRanking} disabled={myLoading}>
              🔄
            </button>
          </div>
          <RankingList
            ranking={myRanking}
            loading={myLoading}
            emptyMsg="Faça uma coleta de posts para ver o ranking de curtidas."
          />
        </div>
      )}

      {/* ===== TAB: MONITORADOS ===== */}
      {tab === 'monitorados' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Lista de perfis monitorados */}
          <div className="card">
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 14 }}>
              Selecione um perfil monitorado:
            </div>
            {monitoredProfiles.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon">🔍</span>
                <p>Nenhum perfil monitorado. Adicione perfis em "Perfis Monitorados".</p>
              </div>
            ) : (
              <ul className="user-list">
                {monitoredProfiles.map(p => (
                  <li
                    key={p.id}
                    className="user-list-item"
                    onClick={() => loadMonitoredRanking(p)}
                    style={{
                      cursor: 'pointer',
                      background: selectedProfile?.id === p.id ? 'rgba(102,126,234,0.12)' : undefined,
                      border: selectedProfile?.id === p.id ? '1px solid rgba(102,126,234,0.35)' : '1px solid transparent',
                      borderRadius: 8,
                      padding: '8px 10px',
                      transition: 'all 0.15s',
                    }}
                  >
                    {p.avatar_url ? (
                      <img
                        src={p.avatar_url}
                        alt={p.username}
                        style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                    ) : (
                      <div className="user-list-avatar">{p.username.charAt(0).toUpperCase()}</div>
                    )}
                    <span style={{ fontWeight: selectedProfile?.id === p.id ? 700 : 400 }}>
                      @{p.username}
                    </span>
                    {selectedProfile?.id === p.id && (
                      <span className="badge badge-info" style={{ marginLeft: 'auto' }}>Selecionado</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Ranking do perfil selecionado */}
          {selectedProfile && (
            <div className="card">
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                  Top 20 — quem mais curtiu posts de @{selectedProfile.username}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                  Baseado nos curtidores da última coleta de cada post monitorado
                </div>
              </div>
              <RankingList
                ranking={monRanking}
                loading={monLoading}
                emptyMsg="Nenhum dado de curtidas ainda. Faça uma coleta de posts de @{selectedProfile.username}."
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
