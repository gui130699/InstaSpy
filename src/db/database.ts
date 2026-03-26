import Dexie, { type Table } from 'dexie'

// ============================================================
// TIPOS
// ============================================================

export interface User {
  id?: number
  email: string
  senha_hash: string
  nome: string
  created_at: number
}

export interface Account {
  id?: number
  user_id: number
  username: string
  session_token: string        // token da sessão no backend (em memória)
  serialized_session?: string  // estado serializado do instagram-private-api
  instagram_pk?: string        // PK numérico do usuário no Instagram
  avatar_url?: string
  created_at: number
  last_sync?: number
}

export interface Snapshot {
  id?: number
  account_id: number
  timestamp: number
  followers_count: number
  following_count: number
  followers_list: string[]
  following_list: string[]
}

export interface Post {
  id?: number
  account_id: number
  post_id: string
  caption: string
  media_url?: string
  created_at: number
  post_timestamp: number
}

export interface PostSnapshot {
  id?: number
  post_id: string
  account_id: number
  timestamp: number
  likes_count: number
  comments_count: number
  likers_list: string[]
}

export interface MonitoredProfile {
  id?: number
  user_id: number
  username: string
  avatar_url?: string
  added_at: number
  notes?: string
}

export interface MonitoredSnapshot {
  id?: number
  profile_id: number
  timestamp: number
  followers_count: number
  following_count: number
  posts_count: number
  last_posts: string[]
  followers_list: string[]
  following_list: string[]
}

export interface MonitoredPost {
  id?: number
  profile_id: number
  post_id: string
  caption: string
  created_at: number
}

export interface MonitoredPostSnapshot {
  id?: number
  post_id: string
  profile_id: number
  timestamp: number
  likes_count: number
  comments_count: number
  likers_list: string[]
}

export interface Alert {
  id?: number
  account_id: number
  timestamp: number
  type: AlertType
  message: string
  read: boolean
  data?: string
}

export type AlertType =
  | 'new_follower'
  | 'lost_follower'
  | 'new_following'
  | 'lost_following'
  | 'new_post'
  | 'new_like'
  | 'lost_like'
  | 'profile_growth'
  | 'profile_decline'

// ============================================================
// BANCO
// ============================================================

export class InstaMonitorDB extends Dexie {
  users!: Table<User>
  accounts!: Table<Account>
  snapshots!: Table<Snapshot>
  posts!: Table<Post>
  post_snapshots!: Table<PostSnapshot>
  monitored_profiles!: Table<MonitoredProfile>
  monitored_snapshots!: Table<MonitoredSnapshot>
  monitored_posts!: Table<MonitoredPost>
  monitored_post_snapshots!: Table<MonitoredPostSnapshot>
  alerts!: Table<Alert>

  constructor() {
    super('insta_monitor_db')

    this.version(1).stores({
      users: '++id, email',
      accounts: '++id, user_id, username',
      snapshots: '++id, account_id, timestamp',
      posts: '++id, account_id, post_id',
      post_snapshots: '++id, post_id, account_id, timestamp',
      monitored_profiles: '++id, user_id, username',
      monitored_snapshots: '++id, profile_id, timestamp',
      alerts: '++id, account_id, timestamp, read'
    })

    this.version(2).stores({
      users: '++id, email',
      accounts: '++id, user_id, username',
      snapshots: '++id, account_id, timestamp',
      posts: '++id, account_id, post_id',
      post_snapshots: '++id, post_id, account_id, timestamp',
      monitored_profiles: '++id, user_id, username',
      monitored_snapshots: '++id, profile_id, timestamp',
      monitored_posts: '++id, profile_id, post_id',
      monitored_post_snapshots: '++id, post_id, profile_id, timestamp',
      alerts: '++id, account_id, timestamp, read'
    })
  }
}

export const db = new InstaMonitorDB()
