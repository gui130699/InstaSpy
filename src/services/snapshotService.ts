import { db, type Snapshot, type PostSnapshot, type Alert } from '../db/database'

// ============================================================
// COMPARAÇÃO DE SNAPSHOTS DE SEGUIDORES
// ============================================================

export interface FollowerDiff {
  newFollowers: string[]
  lostFollowers: string[]
  newFollowing: string[]
  lostFollowing: string[]
}

export function compareSnapshots(prev: Snapshot, curr: Snapshot): FollowerDiff {
  return compareFollowerArrays(
    prev.followers_list, curr.followers_list,
    prev.following_list, curr.following_list
  )
}

// Comparação genérica por arrays (usada também em perfis monitorados)
export function compareFollowerArrays(
  prevFollowers: string[],
  currFollowers: string[],
  prevFollowing: string[],
  currFollowing: string[]
): FollowerDiff {
  const prevFollowersSet = new Set(prevFollowers)
  const currFollowersSet = new Set(currFollowers)
  const prevFollowingSet = new Set(prevFollowing)
  const currFollowingSet = new Set(currFollowing)

  return {
    newFollowers: currFollowers.filter(u => !prevFollowersSet.has(u)),
    lostFollowers: prevFollowers.filter(u => !currFollowersSet.has(u)),
    newFollowing: currFollowing.filter(u => !prevFollowingSet.has(u)),
    lostFollowing: prevFollowing.filter(u => !currFollowingSet.has(u))
  }
}

// ============================================================
// COMPARAÇÃO DE CURTIDAS POR POST
// ============================================================

export interface LikersDiff {
  postId: string
  newLikers: string[]
  lostLikers: string[]
}

export function comparePostSnapshots(prev: PostSnapshot, curr: PostSnapshot): LikersDiff {
  const prevSet = new Set(prev.likers_list)
  const currSet = new Set(curr.likers_list)

  return {
    postId: curr.post_id,
    newLikers: curr.likers_list.filter(u => !prevSet.has(u)),
    lostLikers: prev.likers_list.filter(u => !currSet.has(u))
  }
}

// ============================================================
// SALVAR SNAPSHOT
// ============================================================

export async function saveSnapshot(data: Omit<Snapshot, 'id'>): Promise<number> {
  return db.snapshots.add(data)
}

export async function savePostSnapshot(data: Omit<PostSnapshot, 'id'>): Promise<number> {
  return db.post_snapshots.add(data)
}

// ============================================================
// BUSCAR ÚLTIMO SNAPSHOT
// ============================================================

export async function getLastSnapshot(accountId: number): Promise<Snapshot | undefined> {
  const all = await db.snapshots.where('account_id').equals(accountId).toArray()
  return all.sort((a, b) => b.timestamp - a.timestamp)[0]
}

export async function getLastPostSnapshot(postId: string, accountId: number): Promise<PostSnapshot | undefined> {
  const all = await db.post_snapshots
    .where('post_id').equals(postId)
    .filter(s => s.account_id === accountId)
    .toArray()
  return all.sort((a, b) => b.timestamp - a.timestamp)[0]
}

export async function getSnapshotHistory(accountId: number, limit = 30): Promise<Snapshot[]> {
  const all = await db.snapshots.where('account_id').equals(accountId).toArray()
  return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit)
}

// ============================================================
// GERAR ALERTAS
// ============================================================

export async function generateAlertsFromDiff(
  accountId: number,
  diff: FollowerDiff,
  timestamp: number
): Promise<void> {
  const alerts: Omit<Alert, 'id'>[] = []

  for (const user of diff.newFollowers) {
    alerts.push({
      account_id: accountId,
      timestamp,
      type: 'new_follower',
      message: `@${user} começou a te seguir`,
      read: false,
      data: user
    })
  }

  for (const user of diff.lostFollowers) {
    alerts.push({
      account_id: accountId,
      timestamp,
      type: 'lost_follower',
      message: `@${user} deixou de te seguir`,
      read: false,
      data: user
    })
  }

  for (const user of diff.newFollowing) {
    alerts.push({
      account_id: accountId,
      timestamp,
      type: 'new_following',
      message: `Você começou a seguir @${user}`,
      read: false,
      data: user
    })
  }

  for (const user of diff.lostFollowing) {
    alerts.push({
      account_id: accountId,
      timestamp,
      type: 'lost_following',
      message: `Você deixou de seguir @${user}`,
      read: false,
      data: user
    })
  }

  if (alerts.length > 0) {
    await db.alerts.bulkAdd(alerts)
  }
}

export async function generateLikeAlerts(
  accountId: number,
  diff: LikersDiff,
  postCaption: string,
  timestamp: number
): Promise<void> {
  const alerts: Omit<Alert, 'id'>[] = []

  for (const user of diff.newLikers) {
    alerts.push({
      account_id: accountId,
      timestamp,
      type: 'new_like',
      message: `@${user} curtiu: "${postCaption.slice(0, 40)}"`,
      read: false,
      data: JSON.stringify({ user, postId: diff.postId })
    })
  }

  for (const user of diff.lostLikers) {
    alerts.push({
      account_id: accountId,
      timestamp,
      type: 'lost_like',
      message: `@${user} descurtiu: "${postCaption.slice(0, 40)}"`,
      read: false,
      data: JSON.stringify({ user, postId: diff.postId })
    })
  }

  if (alerts.length > 0) {
    await db.alerts.bulkAdd(alerts)
  }
}
