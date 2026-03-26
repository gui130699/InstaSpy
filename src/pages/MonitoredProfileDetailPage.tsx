import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  db,
  type MonitoredProfile,
  type MonitoredSnapshot,
  type MonitoredPost,
  type MonitoredPostSnapshot
} from '../db/database'
import { compareFollowerArrays } from '../services/snapshotService'
import { runMockMonitoredCollection } from '../services/mockCollector'
import { formatRelativeTime, formatDateTime } from '../utils/formatters'

type MainTab = 'seguidores' | 'seguindo' | 'posts'
type FollowerTab = 'todos' | 'novos' | 'perdidos'
type FollowingTab = 'novos' | 'deixou'

export default function MonitoredProfileDetailPage() {
  const { profileId } = useParams<{ profileId: string }>()
  const navigate = useNavigate()
  const profId = Number(profileId)

  const [profile, setProfile] = useState<MonitoredProfile | null>(null)
  const [snapshots, setSnapshots] = useState<MonitoredSnapshot[]>([])
  const [posts, setPosts] = useState<MonitoredPost[]>([])
  const [postSnapsMap, setPostSnapsMap] = useState<Map<string, MonitoredPostSnapshot[]>>(new Map())
  const [collecting, setCollecting] = useState(false)
  const [collectionMsg, setCollectionMsg] = useState('')

  const [mainTab, setMainTab] = useState<MainTab>('seguidores')
  const [followerTab, setFollowerTab] = useState<FollowerTab>('todos')
  const [followingTab, setFollowingTab] = useState<FollowingTab>('novos')
  const [expandedPost, setExpandedPost] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    if (!profId) return

    const p = await db.monitored_profiles.get(profId)
    setProfile(p ?? null)

    const allMonSnaps = await db.monitored_snapshots.where('profile_id').equals(profId).toArray()
    const snaps = allMonSnaps.sort((a, b) => b.timestamp - a.timestamp).slice(0, 30)
    setSnapshots(snaps)

    const ps = await db.monitored_posts
      .where('profile_id').equals(profId)
      .toArray()
    setPosts(ps)

    const map = new Map<string, MonitoredPostSnapshot[]>()
    for (const post of ps) {
      const rawMps = await db.monitored_post_snapshots.where('post_id').equals(post.post_id).toArray()
      const s = rawMps.sort((a, b) => b.timestamp - a.timestamp).slice(0, 10)
      map.set(post.post_id, s)
    }
    setPostSnapsMap(map)
  }, [profId])

  useEffect(() => {
    loadData()
  }, [loadData])

  async function handleCollect() {
    if (!profId || collecting) return
    setCollecting(true)
    setCollectionMsg('')

    try {
      const result = await runMockMonitoredCollection(profId)
      const total = result.newFollowers.length + result.lostFollowers.length +
        result.newFollowing.length + result.lostFollowing.length
      setCollectionMsg(`✅ Coleta concluída — ${total} mudança(s) nos seguidores`)
      await loadData()
    } catch {
      setCollectionMsg('❌ Erro na coleta')
    } finally {
      setCollecting(false)
      setTimeout(() => setCollectionMsg(''), 3000)
    }
  }

  const latest = snapshots[0]
  const previous = snapshots[1]

  const diff =
    latest?.followers_list?.length && previous?.followers_list?.length
      ? compareFollowerArrays(
          previous.followers_list,
          latest.followers_list,
          previous.following_list ?? [],
          latest.following_list ?? []
        )
      : null

  const followersList = (() => {
    if (!latest) return []
    if (followerTab === 'novos') return diff?.newFollowers ?? []
    if (followerTab === 'perdidos') return diff?.lostFollowers ?? []
    return latest.followers_list ?? []
  })()

  const followingList = (() => {
    if (!latest) return []
    if (followingTab === 'novos') return diff?.newFollowing ?? []
    return diff?.lostFollowing ?? []
  })()

  if (!profile) {
    return (
      <div className="loading">
        <div className="spinner" />
        Carregando perfil...
      </div>
    )
  }

  const followerDelta = latest && previous
    ? (latest.followers_list?.length ?? 0) - (previous.followers_list?.length ?? 0)
    : 0

  return (
    <>
      {/* Header */}
      <div className="topbar" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-outline btn-sm" onClick={() => navigate('/monitored')}>
            ← Voltar
          </button>
          <div>
            <h1 className="topbar-title">@{profile.username}</h1>
            {latest && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                Última coleta: {formatRelativeTime(latest.timestamp)}
              </div>
            )}
          </div>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={handleCollect}
          disabled={collecting}
        >
          {collecting ? '⏳ Coletando...' : '🔄 Coletar agora'}
        </button>
      </div>

      {collectionMsg && (
        <div style={{
          padding: '10px 14px',
          background: collectionMsg.startsWith('✅') ? 'rgba(67,233,123,0.1)' : 'rgba(246,79,89,0.1)',
          border: `1px solid ${collectionMsg.startsWith('✅') ? 'rgba(67,233,123,0.3)' : 'rgba(246,79,89,0.3)'}`,
          borderRadius: 8, fontSize: 13, marginBottom: 20,
          color: collectionMsg.startsWith('✅') ? 'var(--accent-green)' : 'var(--accent-pink)'
        }}>
          {collectionMsg}
        </div>
      )}

      {/* Stats bar */}
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 24 }}>
        <div className="card">
          <div className="card-title">Seguidores</div>
          <div className="card-value">{latest?.followers_count ?? 0}</div>
          {followerDelta !== 0 && (
            <div className={`card-delta ${followerDelta > 0 ? 'positive' : 'negative'}`}>
              {followerDelta > 0 ? '▲' : '▼'} {Math.abs(followerDelta)}
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-title">Seguindo</div>
          <div className="card-value">{latest?.following_count ?? 0}</div>
        </div>
        <div className="card">
          <div className="card-title">Posts</div>
          <div className="card-value">{posts.length}</div>
        </div>
      </div>

      {/* Tabs principais */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, background: 'var(--bg-secondary)', borderRadius: 8, padding: 4 }}>
        {(['seguidores', 'seguindo', 'posts'] as MainTab[]).map(t => (
          <button
            key={t}
            onClick={() => setMainTab(t)}
            style={{
              flex: 1, padding: '10px 8px', border: 'none', cursor: 'pointer',
              background: mainTab === t ? 'var(--accent-primary)' : 'transparent',
              color: mainTab === t ? '#fff' : 'var(--text-muted)',
              borderRadius: 6, fontWeight: mainTab === t ? 700 : 400,
              fontSize: 14, transition: 'all 0.2s', fontFamily: 'inherit'
            }}
          >
            {t === 'seguidores' && '👥 Seguidores'}
            {t === 'seguindo' && '🔵 Seguindo'}
            {t === 'posts' && '📷 Posts'}
          </button>
        ))}
      </div>

      {/* ===== TAB: SEGUIDORES ===== */}
      {mainTab === 'seguidores' && (
        <div className="card">
          {/* Sub-tabs */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
            <SubTabBtn active={followerTab === 'todos'} onClick={() => setFollowerTab('todos')}>
              Todos ({latest?.followers_list?.length ?? 0})
            </SubTabBtn>
            <SubTabBtn active={followerTab === 'novos'} onClick={() => setFollowerTab('novos')} color="success">
              🟢 Novos ({diff?.newFollowers.length ?? 0})
            </SubTabBtn>
            <SubTabBtn active={followerTab === 'perdidos'} onClick={() => setFollowerTab('perdidos')} color="danger">
              🔴 Perdidos ({diff?.lostFollowers.length ?? 0})
            </SubTabBtn>
          </div>

          {followersList.length === 0 ? (
            <EmptyState
              icon={followerTab === 'novos' ? '🟢' : followerTab === 'perdidos' ? '🔴' : '👥'}
              msg={
                followerTab === 'novos' ? 'Nenhum novo seguidor nesta coleta' :
                followerTab === 'perdidos' ? 'Nenhum seguidor perdido nesta coleta' :
                'Faça uma coleta para ver a lista de seguidores'
              }
            />
          ) : (
            <ul className="user-list">
              {followersList.map(u => (
                <li key={u} className="user-list-item">
                  <div className="user-list-avatar">{u.charAt(0).toUpperCase()}</div>
                  <span>@{u}</span>
                  {followerTab === 'novos' && (
                    <span className="badge badge-success" style={{ marginLeft: 'auto' }}>Novo</span>
                  )}
                  {followerTab === 'perdidos' && (
                    <span className="badge badge-danger" style={{ marginLeft: 'auto' }}>Saiu</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ===== TAB: SEGUINDO ===== */}
      {mainTab === 'seguindo' && (
        <div className="card">
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            <SubTabBtn active={followingTab === 'novos'} onClick={() => setFollowingTab('novos')} color="success">
              🔵 Novos seguindo ({diff?.newFollowing.length ?? 0})
            </SubTabBtn>
            <SubTabBtn active={followingTab === 'deixou'} onClick={() => setFollowingTab('deixou')} color="danger">
              ⚪ Deixou de seguir ({diff?.lostFollowing.length ?? 0})
            </SubTabBtn>
          </div>

          <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--text-muted)' }}>
            Total seguindo: <strong style={{ color: 'var(--text-primary)' }}>{latest?.following_count ?? 0}</strong>
          </div>

          {followingList.length === 0 ? (
            <EmptyState
              icon={followingTab === 'novos' ? '🔵' : '⚪'}
              msg={
                followingTab === 'novos' ? 'Nenhum novo seguindo nesta coleta' :
                'Não deixou de seguir ninguém nesta coleta'
              }
            />
          ) : (
            <ul className="user-list">
              {followingList.map(u => (
                <li key={u} className="user-list-item">
                  <div className="user-list-avatar">{u.charAt(0).toUpperCase()}</div>
                  <span>@{u}</span>
                  {followingTab === 'novos' && (
                    <span className="badge badge-info" style={{ marginLeft: 'auto' }}>Seguindo</span>
                  )}
                  {followingTab === 'deixou' && (
                    <span className="badge badge-warning" style={{ marginLeft: 'auto' }}>Saiu</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ===== TAB: POSTS ===== */}
      {mainTab === 'posts' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {posts.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">📷</span>
              <p>Nenhum post encontrado. Faça uma coleta para carregar os posts.</p>
            </div>
          ) : (
            posts.map(post => {
              const snaps = postSnapsMap.get(post.post_id) ?? []
              const latest = snaps[0]
              const previous = snaps[1]
              const isExpanded = expandedPost === post.post_id

              const likersDiff = latest && previous
                ? {
                    newLikers: latest.likers_list.filter(u => !new Set(previous.likers_list).has(u)),
                    lostLikers: previous.likers_list.filter(u => !new Set(latest.likers_list).has(u))
                  }
                : null

              return (
                <div key={post.post_id} className="card" style={{ cursor: 'pointer' }}>
                  {/* Post header clicável */}
                  <div
                    onClick={() => setExpandedPost(isExpanded ? null : post.post_id)}
                    style={{ display: 'flex', alignItems: 'flex-start', gap: 12, justifyContent: 'space-between' }}
                  >
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.5, marginBottom: 10 }}>
                        {post.caption}
                      </p>
                      <div style={{ display: 'flex', gap: 16 }}>
                        <div className="post-meta-item">
                          <span>👍</span>
                          <span style={{ fontWeight: 700 }}>{latest?.likes_count ?? 0}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>curtidas</span>
                        </div>
                        <div className="post-meta-item">
                          <span>💬</span>
                          <span style={{ fontWeight: 700 }}>{latest?.comments_count ?? 0}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>comentários</span>
                        </div>
                        {likersDiff && likersDiff.newLikers.length > 0 && (
                          <span className="badge badge-success">+{likersDiff.newLikers.length} curtiram</span>
                        )}
                        {likersDiff && likersDiff.lostLikers.length > 0 && (
                          <span className="badge badge-danger">-{likersDiff.lostLikers.length} descurtiram</span>
                        )}
                      </div>
                    </div>
                    <span style={{ color: 'var(--text-muted)', fontSize: 18, marginLeft: 8 }}>
                      {isExpanded ? '▲' : '▼'}
                    </span>
                  </div>

                  {/* Painel expandido */}
                  {isExpanded && (
                    <div style={{ marginTop: 20, borderTop: '1px solid var(--border-color)', paddingTop: 16 }}>
                      <div className="content-grid" style={{ gap: 16 }}>

                        {/* Quem curtiu (lista completa) */}
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 10 }}>
                            👍 Quem curtiu ({latest?.likers_list.length ?? 0})
                          </div>
                          {!latest || latest.likers_list.length === 0 ? (
                            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Sem curtidas registradas</p>
                          ) : (
                            <ul className="user-list">
                              {latest.likers_list.map(u => (
                                <li key={u} className="user-list-item">
                                  <div className="user-list-avatar">{u.charAt(0).toUpperCase()}</div>
                                  <span>@{u}</span>
                                  {likersDiff?.newLikers.includes(u) && (
                                    <span className="badge badge-success" style={{ marginLeft: 'auto' }}>Novo</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>

                        {/* Mudanças */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

                          {/* Novos curtidores */}
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent-green)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                              🟢 Curtiram recentemente
                              <span className="badge badge-success">{likersDiff?.newLikers.length ?? 0}</span>
                            </div>
                            {!likersDiff || likersDiff.newLikers.length === 0 ? (
                              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nenhum novo curtimento</p>
                            ) : (
                              <ul className="user-list">
                                {likersDiff.newLikers.map(u => (
                                  <li key={u} className="user-list-item">
                                    <div className="user-list-avatar" style={{ background: 'var(--gradient-success)' }}>
                                      {u.charAt(0).toUpperCase()}
                                    </div>
                                    @{u}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>

                          {/* Descurtiram */}
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent-pink)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                              🔴 Descurtiram
                              <span className="badge badge-danger">{likersDiff?.lostLikers.length ?? 0}</span>
                            </div>
                            {!likersDiff || likersDiff.lostLikers.length === 0 ? (
                              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nenhuma descurtida</p>
                            ) : (
                              <ul className="user-list">
                                {likersDiff.lostLikers.map(u => (
                                  <li key={u} className="user-list-item">
                                    <div className="user-list-avatar" style={{ background: 'var(--gradient-danger)' }}>
                                      {u.charAt(0).toUpperCase()}
                                    </div>
                                    @{u}
                                    <span className="badge badge-danger" style={{ marginLeft: 'auto' }}>Saiu</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Histórico de snapshots do post */}
                      {snaps.length > 1 && (
                        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-color)' }}>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                            📅 Histórico ({snaps.length} coletas)
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {snaps.map((s, i) => (
                              <div key={s.id} style={{
                                padding: '4px 10px',
                                background: i === 0 ? 'rgba(102,126,234,0.15)' : 'var(--bg-primary)',
                                border: `1px solid ${i === 0 ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                                borderRadius: 6, fontSize: 11, color: i === 0 ? 'var(--accent-primary)' : 'var(--text-muted)'
                              }}>
                                {formatDateTime(s.timestamp)} · {s.likes_count} 👍
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
    </>
  )
}

// Sub-componentes utilitários
function SubTabBtn({
  active, onClick, children, color
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  color?: 'success' | 'danger'
}) {
  const bg = active
    ? color === 'success' ? 'rgba(67,233,123,0.2)' : color === 'danger' ? 'rgba(246,79,89,0.2)' : 'rgba(102,126,234,0.2)'
    : 'var(--bg-secondary)'
  const borderColor = active
    ? color === 'success' ? 'var(--accent-green)' : color === 'danger' ? 'var(--accent-pink)' : 'var(--accent-primary)'
    : 'var(--border-color)'
  const textColor = active
    ? color === 'success' ? 'var(--accent-green)' : color === 'danger' ? 'var(--accent-pink)' : 'var(--accent-primary)'
    : 'var(--text-muted)'

  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 14px', border: `1px solid ${borderColor}`,
        background: bg, color: textColor, borderRadius: 8,
        fontSize: 13, fontWeight: active ? 700 : 400,
        cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.2s'
      }}
    >
      {children}
    </button>
  )
}

function EmptyState({ icon, msg }: { icon: string; msg: string }) {
  return (
    <div className="empty-state" style={{ padding: '32px 20px' }}>
      <span className="empty-icon">{icon}</span>
      <p>{msg}</p>
    </div>
  )
}
