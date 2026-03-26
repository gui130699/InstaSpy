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

// Pool de usuários simulados
const USER_POOL = [
  'ana_silva', 'bruno_costa', 'carla_mendes', 'diego_lima', 'elena_souza',
  'fabio_nunes', 'gabriela_ramos', 'henrique_alves', 'isabela_ferreira', 'joao_santos',
  'karen_oliveira', 'lucas_pereira', 'marina_rocha', 'nicolas_barbosa', 'olivia_martins',
  'pedro_gomes', 'quezia_melo', 'rafael_cardoso', 'sabrina_fernandes', 'thiago_moreira',
  'ursula_pinto', 'vinicius_lopes', 'wanessa_freitas', 'xavier_campos', 'yara_monteiro',
  'zeca_ribeiro', 'alice_teixeira', 'bernardo_correia', 'cindy_vieira', 'danilo_farias'
]

function randomSubset(arr: string[], min: number, max: number): string[] {
  const size = Math.floor(Math.random() * (max - min + 1)) + min
  const shuffled = [...arr].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, size)
}

function addSome(list: string[], pool: string[], count: number): string[] {
  const notInList = pool.filter(u => !list.includes(u))
  const toAdd = notSome(notInList, count)
  return [...list, ...toAdd]
}

function notSome(arr: string[], count: number): string[] {
  return arr.sort(() => Math.random() - 0.5).slice(0, Math.min(count, arr.length))
}

function removeSome(list: string[], count: number): string[] {
  const toRemove = new Set(notSome(list, count))
  return list.filter(u => !toRemove.has(u))
}

// ============================================================
// INICIALIZAR DADOS MOCK
// ============================================================

export async function initMockData(accountId: number): Promise<void> {
  const existing = await db.snapshots.where('account_id').equals(accountId).count()
  if (existing > 0) return // já tem dados

  const followersList = randomSubset(USER_POOL, 12, 18)
  const followingList = randomSubset(USER_POOL, 8, 14)

  await saveSnapshot({
    account_id: accountId,
    timestamp: Date.now() - 1000 * 60 * 60 * 24, // ontem
    followers_count: followersList.length,
    following_count: followingList.length,
    followers_list: followersList,
    following_list: followingList
  })

  // Posts iniciais
  const mockPosts = [
    { post_id: 'post_001', caption: 'Que dia incrível! 🌅 #morning', media_url: '' },
    { post_id: 'post_002', caption: 'Novo projeto em andamento 🔥 #dev', media_url: '' },
    { post_id: 'post_003', caption: 'Saudades desse lugar ❤️ #travel', media_url: '' }
  ]

  const now = Date.now()
  for (const p of mockPosts) {
    const existing = await db.posts.where('post_id').equals(p.post_id).first()
    if (!existing) {
      await db.posts.add({
        account_id: accountId,
        post_id: p.post_id,
        caption: p.caption,
        media_url: p.media_url,
        created_at: now,
        post_timestamp: now - Math.random() * 1000 * 60 * 60 * 24 * 7
      })
    }

    const likersList = randomSubset(USER_POOL, 5, 12)
    await savePostSnapshot({
      post_id: p.post_id,
      account_id: accountId,
      timestamp: Date.now() - 1000 * 60 * 60 * 24,
      likes_count: likersList.length,
      comments_count: Math.floor(Math.random() * 8),
      likers_list: likersList
    })
  }
}

// ============================================================
// SIMULAR NOVA COLETA
// ============================================================

export async function runMockCollection(accountId: number): Promise<{
  followersDiff: { newFollowers: string[], lostFollowers: string[], newFollowing: string[], lostFollowing: string[] }
  likerDiffs: Array<{ postId: string, newLikers: string[], lostLikers: string[] }>
  timestamp: number
}> {
  const timestamp = Date.now()
  const lastSnap = await getLastSnapshot(accountId)

  if (!lastSnap) {
    await initMockData(accountId)
    return {
      followersDiff: { newFollowers: [], lostFollowers: [], newFollowing: [], lostFollowing: [] },
      likerDiffs: [],
      timestamp
    }
  }

  // Simular variações de seguidores
  let newFollowers = [...lastSnap.followers_list]
  let newFollowing = [...lastSnap.following_list]

  const addCount = Math.floor(Math.random() * 4)
  const removeCount = Math.floor(Math.random() * 2)
  const addFollowCount = Math.floor(Math.random() * 2)
  const removeFollowCount = Math.floor(Math.random() * 2)

  if (addCount > 0) newFollowers = addSome(newFollowers, USER_POOL, addCount)
  if (removeCount > 0) newFollowers = removeSome(newFollowers, removeCount)
  if (addFollowCount > 0) newFollowing = addSome(newFollowing, USER_POOL, addFollowCount)
  if (removeFollowCount > 0) newFollowing = removeSome(newFollowing, removeFollowCount)

  const newSnap = await saveSnapshot({
    account_id: accountId,
    timestamp,
    followers_count: newFollowers.length,
    following_count: newFollowing.length,
    followers_list: newFollowers,
    following_list: newFollowing
  })

  const freshSnap = await db.snapshots.get(newSnap)
  const followersDiff = compareSnapshots(lastSnap, freshSnap!)
  await generateAlertsFromDiff(accountId, followersDiff, timestamp)

  // Simular variações de curtidas
  const posts = await db.posts.where('account_id').equals(accountId).toArray()
  const likerDiffs = []

  for (const post of posts) {
    const lastPostSnap = await getLastPostSnapshot(post.post_id, accountId)
    if (!lastPostSnap) continue

    let newLikers = [...lastPostSnap.likers_list]
    const addL = Math.floor(Math.random() * 3)
    const removeL = Math.floor(Math.random() * 2)

    if (addL > 0) newLikers = addSome(newLikers, USER_POOL, addL)
    if (removeL > 0) newLikers = removeSome(newLikers, removeL)

    const newPostSnapId = await savePostSnapshot({
      post_id: post.post_id,
      account_id: accountId,
      timestamp,
      likes_count: newLikers.length,
      comments_count: lastPostSnap.comments_count + Math.floor(Math.random() * 2),
      likers_list: newLikers
    })

    const freshPostSnap = await db.post_snapshots.get(newPostSnapId)
    const diff = comparePostSnapshots(lastPostSnap, freshPostSnap!)
    likerDiffs.push(diff)

    if (diff.newLikers.length > 0 || diff.lostLikers.length > 0) {
      await generateLikeAlerts(accountId, diff, post.caption, timestamp)
    }
  }

  // Atualizar last_sync da conta
  await db.accounts.update(accountId, { last_sync: timestamp })

  return { followersDiff, likerDiffs, timestamp }
}

// ============================================================
// MOCK PARA PERFIS MONITORADOS
// ============================================================

const MONITORED_CAPTIONS = [
  '✨ Que dia lindo! Aproveitando cada momento 💫',
  '🌊 Nada como o mar para renovar as energias!',
  '📸 Nova foto! O que acharam? Comentem! ❤️',
  '🔥 Mais um projeto incrível finalizado! #trabalho',
  '🌿 Natureza é vida! Amo esses momentos de paz 🌱',
  '🎉 Celebrando com os amigos! Vida boa demais! 🥂',
  '💪 Consistência é a chave do sucesso!',
  '🎨 Criatividade não tem limites! Novo projeto chegando...'
]

export async function initMockMonitoredData(profileId: number): Promise<void> {
  const existing = await db.monitored_snapshots
    .where('profile_id').equals(profileId).count()
  if (existing > 0) return

  const followersList = randomSubset(USER_POOL, 15, 25)
  const followingList = randomSubset(USER_POOL, 8, 15)

  await db.monitored_snapshots.add({
    profile_id: profileId,
    timestamp: Date.now() - 1000 * 60 * 60 * 24,
    followers_count: followersList.length,
    following_count: followingList.length,
    posts_count: 3,
    last_posts: [],
    followers_list: followersList,
    following_list: followingList
  })

  const mockPosts = [
    { post_id: `mp_${profileId}_001`, caption: MONITORED_CAPTIONS[Math.floor(Math.random() * MONITORED_CAPTIONS.length)] },
    { post_id: `mp_${profileId}_002`, caption: MONITORED_CAPTIONS[Math.floor(Math.random() * MONITORED_CAPTIONS.length)] },
    { post_id: `mp_${profileId}_003`, caption: MONITORED_CAPTIONS[Math.floor(Math.random() * MONITORED_CAPTIONS.length)] }
  ]

  const now = Date.now()
  for (const p of mockPosts) {
    const existingPost = await db.monitored_posts.where('post_id').equals(p.post_id).first()
    if (!existingPost) {
      await db.monitored_posts.add({
        profile_id: profileId,
        post_id: p.post_id,
        caption: p.caption,
        created_at: now - Math.floor(Math.random() * 1000 * 60 * 60 * 24 * 14)
      })
    }

    const likersList = randomSubset(USER_POOL, 4, 12)
    await db.monitored_post_snapshots.add({
      post_id: p.post_id,
      profile_id: profileId,
      timestamp: Date.now() - 1000 * 60 * 60 * 24,
      likes_count: likersList.length,
      comments_count: Math.floor(Math.random() * 8),
      likers_list: likersList
    })
  }
}

export async function runMockMonitoredCollection(profileId: number): Promise<{
  newFollowers: string[]
  lostFollowers: string[]
  newFollowing: string[]
  lostFollowing: string[]
}> {
  const timestamp = Date.now()

  const allMonSnaps = await db.monitored_snapshots.where('profile_id').equals(profileId).toArray()
  const lastSnap = allMonSnaps.sort((a, b) => b.timestamp - a.timestamp)[0]

  if (!lastSnap) {
    await initMockMonitoredData(profileId)
    return { newFollowers: [], lostFollowers: [], newFollowing: [], lostFollowing: [] }
  }

  let newFollowers = [...(lastSnap.followers_list ?? [])]
  let newFollowing = [...(lastSnap.following_list ?? [])]

  const addCount = Math.floor(Math.random() * 5)
  const removeCount = Math.floor(Math.random() * 3)
  const addFollowCount = Math.floor(Math.random() * 3)
  const removeFollowCount = Math.floor(Math.random() * 2)

  if (addCount > 0) newFollowers = addSome(newFollowers, USER_POOL, addCount)
  if (removeCount > 0) newFollowers = removeSome(newFollowers, removeCount)
  if (addFollowCount > 0) newFollowing = addSome(newFollowing, USER_POOL, addFollowCount)
  if (removeFollowCount > 0) newFollowing = removeSome(newFollowing, removeFollowCount)

  await db.monitored_snapshots.add({
    profile_id: profileId,
    timestamp,
    followers_count: newFollowers.length,
    following_count: newFollowing.length,
    posts_count: lastSnap.posts_count,
    last_posts: lastSnap.last_posts,
    followers_list: newFollowers,
    following_list: newFollowing
  })

  // Simular mudanças de curtidas nos posts monitorados
  const posts = await db.monitored_posts.where('profile_id').equals(profileId).toArray()

  for (const post of posts) {
    const rawMpSnaps = await db.monitored_post_snapshots.where('post_id').equals(post.post_id).toArray()
    const lastPostSnap = rawMpSnaps.sort((a, b) => b.timestamp - a.timestamp)[0]

    if (!lastPostSnap) continue

    let newLikers = [...lastPostSnap.likers_list]
    const addL = Math.floor(Math.random() * 4)
    const removeL = Math.floor(Math.random() * 2)

    if (addL > 0) newLikers = addSome(newLikers, USER_POOL, addL)
    if (removeL > 0) newLikers = removeSome(newLikers, removeL)

    await db.monitored_post_snapshots.add({
      post_id: post.post_id,
      profile_id: profileId,
      timestamp,
      likes_count: newLikers.length,
      comments_count: lastPostSnap.comments_count + Math.floor(Math.random() * 2),
      likers_list: newLikers
    })
  }

  // Calcular diff para retornar
  const prevFollowers = new Set(lastSnap.followers_list ?? [])
  const prevFollowing = new Set(lastSnap.following_list ?? [])

  return {
    newFollowers: newFollowers.filter(u => !prevFollowers.has(u)),
    lostFollowers: (lastSnap.followers_list ?? []).filter(u => !newFollowers.includes(u)),
    newFollowing: newFollowing.filter(u => !prevFollowing.has(u)),
    lostFollowing: (lastSnap.following_list ?? []).filter(u => !newFollowing.includes(u))
  }
}
