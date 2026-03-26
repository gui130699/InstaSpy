import bcrypt from 'bcryptjs'
import { db, type User } from '../db/database'

const SESSION_KEY = 'instamonitor_session'

export interface SessionData {
  userId: number
  email: string
  nome: string
}

export async function register(email: string, senha: string, nome: string): Promise<User> {
  const existing = await db.users.where('email').equals(email).first()
  if (existing) throw new Error('E-mail já cadastrado')

  const senha_hash = await bcrypt.hash(senha, 10)
  const id = await db.users.add({
    email,
    senha_hash,
    nome,
    created_at: Date.now()
  })

  return db.users.get(id) as Promise<User>
}

export async function login(email: string, senha: string): Promise<SessionData> {
  const user = await db.users.where('email').equals(email).first()
  if (!user) throw new Error('Usuário não encontrado')

  const valid = await bcrypt.compare(senha, user.senha_hash)
  if (!valid) throw new Error('Senha incorreta')

  const session: SessionData = {
    userId: user.id!,
    email: user.email,
    nome: user.nome
  }
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
  return session
}

export function logout(): void {
  sessionStorage.removeItem(SESSION_KEY)
}

export function getSession(): SessionData | null {
  const raw = sessionStorage.getItem(SESSION_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SessionData
  } catch {
    return null
  }
}

export function isAuthenticated(): boolean {
  return getSession() !== null
}
