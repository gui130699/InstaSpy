import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { db, type Post, type PostSnapshot } from '../db/database'
import { proxyAvatarUrl } from '../services/apiClient'

export default function PostsPage() {
  const { accountId } = useAuth()
  const navigate = useNavigate()
  const [posts, setPosts] = useState<Post[]>([])
  const [latestSnaps, setLatestSnaps] = useState<Map<string, PostSnapshot>>(new Map())

  useEffect(() => {
    if (!accountId) return
    loadPosts()
  }, [accountId])

  async function loadPosts() {
    if (!accountId) return
    const p = await db.posts.where('account_id').equals(accountId).toArray()
    p.sort((a, b) => b.post_timestamp - a.post_timestamp)
    setPosts(p)

    const snapMap = new Map<string, PostSnapshot>()
    for (const post of p) {
      const postSnaps = await db.post_snapshots.where('post_id').equals(post.post_id).toArray()
      const snap = postSnaps.sort((a, b) => b.timestamp - a.timestamp)[0]
      if (snap) snapMap.set(post.post_id, snap)
    }
    setLatestSnaps(snapMap)
  }

  return (
    <>
      <div className="topbar">
        <h1 className="topbar-title">📷 Posts</h1>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {posts.length} publicação(ões)
        </span>
      </div>

      {posts.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">📷</span>
          <p>Nenhum post encontrado. Faça uma coleta no Dashboard.</p>
        </div>
      ) : (
        <div className="posts-grid">
          {posts.map(post => {
            const snap = latestSnaps.get(post.post_id)
            return (
              <div
                key={post.post_id}
                className="post-card"
                onClick={() => navigate(`/posts/${post.post_id}`)}
              >
                {post.media_url && (
                  <img
                    src={proxyAvatarUrl(post.media_url)}
                    alt="Post"
                    style={{
                      width: '100%', borderRadius: 8, marginBottom: 10,
                      maxHeight: 200, objectFit: 'cover', display: 'block',
                    }}
                    onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                  />
                )}
                <p className="post-caption">{post.caption}</p>
                <div className="post-meta">
                  <div className="post-meta-item">
                    <span>👍</span>
                    <span>{snap?.likes_count ?? 0} curtidas</span>
                  </div>
                  <div className="post-meta-item">
                    <span>💬</span>
                    <span>{snap?.comments_count ?? 0} comentários</span>
                  </div>
                </div>
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-color)' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    ID: {post.post_id}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
