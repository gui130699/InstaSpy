import { db } from '../db/database'
import {
  saveSnapshot,
  savePostSnapshot,
  getLastSnapshot,
  getLastPostSnapshot,
  compareSnapshots,
  comparePostSnapshots,
  generateAlertsFromDiff,
  generateLikeAlerts
} from './snapshotService'
import { api } from './apiClient'

// ─── Verificar/restaurar sessão ───────────────────────────────────────────────

/**
 * Garante que temos um token válido no backend.
 * Se o token em memória for inválido, tenta restaurar pelo estado serializado.
 */
async function ensureSession(accountId: number): Promise<string> {
  const acc = await db.accounts.get(accountId)
  if (!acc) throw new Error('Conta não encontrada')

  const result = await api.restoreSession(
    acc.session_token ?? null,
    acc.serialized_session ?? null
  )

  if (!result.ok || !result.token) {
    throw new Error('Sessão expirada. Reconecte sua conta em Configurações.')
  }

  // Persiste novo token se o backend gerou um diferente
  if (result.token !== acc.session_token) {
    await db.accounts.update(accountId, { session_token: result.token })
  }

  return result.token
}

// ─── Coleta real ──────────────────────────────────────────────────────────────

export async function runRealCollection(accountId: number, mode?: string) {
  const token = await ensureSession(accountId)
  const data = await api.collect(token, mode)

  const now = data.collected_at ?? Date.now()

  // Atualiza metadados da conta
  await db.accounts.update(accountId, {
    avatar_url: data.account.avatar_url,
    last_sync: now
  })

  // ── Seguidores ──
  const lastSnap = await getLastSnapshot(accountId)

  await saveSnapshot({
    account_id: accountId,
    timestamp: now,
    // Usar tamanho da lista como fallback quando current_user retornou 0
    followers_count: data.account.followers_count || data.followers.length,
    following_count: data.account.following_count || data.following.length,
    followers_list: data.followers,
    following_list: data.following
  })

  const newSnap = await getLastSnapshot(accountId)

  const followersDiff =
    lastSnap && newSnap
      ? compareSnapshots(lastSnap, newSnap)
      : { newFollowers: [], lostFollowers: [], newFollowing: [], lostFollowing: [] }

  if (lastSnap && newSnap) {
    await generateAlertsFromDiff(accountId, followersDiff, now)
  }

  // ── Posts e curtidas ──
  const likerDiffs = []

  for (const post of data.posts) {
    // Garante que o post existe no banco
    const existingPost = await db.posts.where('post_id').equals(post.post_id).first()
    if (!existingPost) {
      await db.posts.add({
        account_id: accountId,
        post_id: post.post_id,
        caption: post.caption,
        media_url: post.media_url ?? '',
        created_at: post.created_at,
        post_timestamp: post.created_at
      })
    }

    const lastPostSnap = await getLastPostSnapshot(post.post_id, accountId)

    await savePostSnapshot({
      post_id: post.post_id,
      account_id: accountId,
      timestamp: now,
      likes_count: post.likes_count,
      comments_count: post.comments_count,
      likers_list: post.likers_list
    })

    const newPostSnap = await getLastPostSnapshot(post.post_id, accountId)

    const diff =
      lastPostSnap && newPostSnap
        ? comparePostSnapshots(lastPostSnap, newPostSnap)
        : { postId: post.post_id, newLikers: [], lostLikers: [] }

    likerDiffs.push(diff)

    if (lastPostSnap && newPostSnap && post.likers_list.length > 0) {
      await generateLikeAlerts(accountId, diff, post.caption, now)
    }
  }

  return { followersDiff, likerDiffs, partial: !!data.partial, skipped: data.skipped ?? [], account: data.account }
}
