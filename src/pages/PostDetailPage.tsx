import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { db, type Post, type PostSnapshot } from '../db/database'
import { comparePostSnapshots } from '../services/snapshotService'
import { formatDateTime } from '../utils/formatters'
import UserChip from '../components/UserChip'
import { proxyAvatarUrl } from '../services/apiClient'

export default function PostDetailPage() {
  const { postId } = useParams<{ postId: string }>()
  const { accountId } = useAuth()
  const navigate = useNavigate()

  const [post, setPost] = useState<Post | null>(null)
  const [snapshots, setSnapshots] = useState<PostSnapshot[]>([])
  const [activeSnap, setActiveSnap] = useState<PostSnapshot | null>(null)
  const [prevSnap, setPrevSnap] = useState<PostSnapshot | null>(null)

  useEffect(() => {
    if (!postId || !accountId) return
    loadData()
  }, [postId, accountId])

  async function loadData() {
    if (!postId || !accountId) return

    const p = await db.posts.where('post_id').equals(postId).first()
    setPost(p ?? null)

    const allSnaps = await db.post_snapshots.where('post_id').equals(postId).toArray()
    const snaps = allSnaps.sort((a, b) => b.timestamp - a.timestamp).slice(0, 20)

    setSnapshots(snaps)
    setActiveSnap(snaps[0] ?? null)
    setPrevSnap(snaps[1] ?? null)
  }

  if (!post) {
    return (
      <div className="loading">
        <div className="spinner" />
        Carregando...
      </div>
    )
  }

  const diff = activeSnap && prevSnap
    ? comparePostSnapshots(prevSnap, activeSnap)
    : null

  return (
    <>
      <div className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-outline btn-sm" onClick={() => navigate('/posts')}>
            ← Voltar
          </button>
          <h1 className="topbar-title">📷 Detalhe do Post</h1>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        {/* Imagem do post */}
        {post.media_url && (
          <img
            src={proxyAvatarUrl(post.media_url)}
            alt="Post"
            style={{
              width: '100%', borderRadius: 10, marginBottom: 14,
              maxHeight: 360, objectFit: 'cover',
            }}
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
          />
        )}
        <p style={{ fontSize: 15, color: 'var(--text-primary)', lineHeight: 1.6, marginBottom: 12 }}>
          {post.caption}
        </p>
        <div style={{ display: 'flex', gap: 16 }}>
          <div className="post-meta-item">
            <span>👍</span>
            <span style={{ fontWeight: 700, fontSize: 18 }}>{activeSnap?.likes_count ?? 0}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>curtidas</span>
          </div>
          <div className="post-meta-item">
            <span>💬</span>
            <span style={{ fontWeight: 700, fontSize: 18 }}>{activeSnap?.comments_count ?? 0}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>comentários</span>
          </div>
        </div>
      </div>

      <div className="content-grid">
        {/* Coluna curtidas atuais */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">👍 Quem curtiu</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {activeSnap?.likers_list.length ?? 0} pessoas
            </span>
          </div>
          {!activeSnap ? (
            <div className="empty-state">
              <span className="empty-icon">👍</span>
              <p>Sem dados ainda</p>
            </div>
          ) : (
            <ul className="user-list">
              {activeSnap.likers_list.map(u => (
                <UserChip
                  key={u}
                  username={u}
                  badge={diff?.newLikers.includes(u)
                    ? <span className="badge badge-success">Novo</span>
                    : undefined
                  }
                />
              ))}
            </ul>
          )}
        </div>

        {/* Coluna mudanças */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <span className="card-title">🟢 Curtiram recentemente</span>
              <span className="badge badge-success">{diff?.newLikers.length ?? 0}</span>
            </div>
            {!diff || diff.newLikers.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nenhum novo curtimento</p>
            ) : (
              <ul className="user-list">
                {diff.newLikers.map(u => (
                  <UserChip key={u} username={u} />
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">🔴 Descurtiram</span>
              <span className="badge badge-danger">{diff?.lostLikers.length ?? 0}</span>
            </div>
            {!diff || diff.lostLikers.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nenhuma descurtida</p>
            ) : (
              <ul className="user-list">
                {diff.lostLikers.map(u => (
                  <UserChip
                    key={u}
                    username={u}
                    badge={<span className="badge badge-danger">Saiu</span>}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Timeline de snapshots */}
      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-header">
          <span className="card-title">📅 Histórico de snapshots</span>
        </div>
        <ul className="timeline-list">
          {snapshots.map((snap, i) => (
            <li
              key={snap.id}
              className={`timeline-item ${activeSnap?.id === snap.id ? 'unread' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setActiveSnap(snap)
                setPrevSnap(snapshots[i + 1] ?? null)
              }}
            >
              <span className="timeline-icon">📸</span>
              <div className="timeline-content">
                <div className="timeline-message">
                  {snap.likes_count} curtidas · {snap.comments_count} comentários
                </div>
                <div className="timeline-time">{formatDateTime(snap.timestamp)}</div>
              </div>
              {activeSnap?.id === snap.id && (
                <span className="badge badge-info">Ativo</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
