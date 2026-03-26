import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { api } from '../services/apiClient'
import { runRealMonitoredCollection, runRealCollection } from '../services/realCollector'
import { db } from '../db/database'

export interface CollectionProgress {
  step: string
  message: string
  pct: number
  latestUsers?: string[]
}

export interface CollectionJob {
  profId: number
  username: string
}

export interface CollectionResult {
  newFollowers: string[]
  lostFollowers: string[]
  newFollowing: string[]
  lostFollowing: string[]
}

// ─── Fila de tarefas ──────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'in-progress' | 'done' | 'error'
export type TaskType = 'own' | 'monitored'

export interface TaskItem {
  id: string
  type: TaskType
  profId?: number      // apenas para monitored
  accountId: number
  username: string
  mode: string
  status: TaskStatus
  message: string
  startedAt?: number
  finishedAt?: number
  result?: { total: number }
}

// ─── Tipo do contexto ─────────────────────────────────────────────────────────

interface CollectionContextType {
  // Compatibilidade com MonitoredProfileDetailPage
  job: CollectionJob | null
  collecting: boolean
  collectionMsg: string
  collectProgress: CollectionProgress | null
  lastResult: CollectionResult | null
  startCollection: (profId: number, username: string, accountId: number, modeParam: string) => void
  clearMsg: () => void
  // Fila de tarefas
  tasks: TaskItem[]
  enqueueBatch: (items: Omit<TaskItem, 'id' | 'status' | 'message'>[]) => void
  clearCompleted: () => void
  cancelPending: (id: string) => void
}

const CollectionContext = createContext<CollectionContextType>({
  job: null,
  collecting: false,
  collectionMsg: '',
  collectProgress: null,
  lastResult: null,
  startCollection: () => {},
  clearMsg: () => {},
  tasks: [],
  enqueueBatch: () => {},
  clearCompleted: () => {},
  cancelPending: () => {}
})

export function useCollection() {
  return useContext(CollectionContext)
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function CollectionProvider({ children }: { children: ReactNode }) {
  const [job, setJob] = useState<CollectionJob | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [collectionMsg, setCollectionMsg] = useState('')
  const [collectProgress, setCollectProgress] = useState<CollectionProgress | null>(null)
  const [lastResult, setLastResult] = useState<CollectionResult | null>(null)
  const [tasks, setTasks] = useState<TaskItem[]>([])

  const isProcessing = useRef(false)
  const accountIdRef = useRef<number | null>(null)
  const tasksRef = useRef<TaskItem[]>([])

  // Mantém ref sincronizada com o state
  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

  // ── Polling de progresso ──────────────────────────────────────────────────
  useEffect(() => {
    if (!collecting) {
      setCollectProgress(null)
      return
    }
    const interval = setInterval(async () => {
      const accId = accountIdRef.current
      if (!accId) return
      try {
        const acc = await db.accounts.get(accId)
        if (!acc?.session_token) return
        const p = await api.getCollectProgress(acc.session_token)
        if (p.active && p.step) {
          setCollectProgress({ step: p.step, message: p.message ?? '', pct: p.pct ?? 0, latestUsers: p.latestUsers })
        }
      } catch { /* ignora */ }
    }, 2000)
    return () => clearInterval(interval)
  }, [collecting])

  // ── Processar fila ────────────────────────────────────────────────────────
  const processQueue = useCallback(async () => {
    if (isProcessing.current) return
    isProcessing.current = true

    while (true) {
      const pending = tasksRef.current.find(t => t.status === 'pending')
      if (!pending) break

      // Marcar como in-progress
      accountIdRef.current = pending.accountId
      setTasks(prev => prev.map(t => t.id === pending.id
        ? { ...t, status: 'in-progress', startedAt: Date.now() }
        : t
      ))
      setJob({ profId: pending.profId ?? 0, username: pending.username })
      setCollecting(true)
      setCollectionMsg('')
      setLastResult(null)

      try {
        if (pending.type === 'monitored' && pending.profId) {
          const result = await runRealMonitoredCollection(pending.profId, pending.accountId, pending.mode)
          const total = result.newFollowers.length + result.lostFollowers.length +
            result.newFollowing.length + result.lostFollowing.length
          setLastResult(result)
          const msg = `✅ ${total} mudança(s)`
          setCollectionMsg(`✅ @${pending.username} — ${total} mudança(s)`)
          setTasks(prev => prev.map(t => t.id === pending.id
            ? { ...t, status: 'done', message: msg, finishedAt: Date.now(), result: { total } }
            : t
          ))
        } else {
          // own profile
          const result = await runRealCollection(pending.accountId, pending.mode)
          const total = result.followersDiff.newFollowers.length + result.followersDiff.lostFollowers.length +
            result.likerDiffs.reduce((a, d) => a + d.newLikers.length + d.lostLikers.length, 0)
          const ownResult: CollectionResult = {
            newFollowers: result.followersDiff.newFollowers,
            lostFollowers: result.followersDiff.lostFollowers,
            newFollowing: result.followersDiff.newFollowing,
            lostFollowing: result.followersDiff.lostFollowing
          }
          setLastResult(ownResult)
          const msg = `✅ ${total} evento(s)`
          setCollectionMsg(`✅ @${pending.username} — ${total} evento(s)`)
          setTasks(prev => prev.map(t => t.id === pending.id
            ? { ...t, status: 'done', message: msg, finishedAt: Date.now(), result: { total } }
            : t
          ))
        }
      } catch (err) {
        const msg = `❌ ${err instanceof Error ? err.message : 'Erro'}`
        setCollectionMsg(msg)
        setTasks(prev => prev.map(t => t.id === pending.id
          ? { ...t, status: 'error', message: msg, finishedAt: Date.now() }
          : t
        ))
      }

      // Pequena pausa entre tarefas para não sobrecarregar
      await new Promise(r => setTimeout(r, 800))
    }

    setCollecting(false)
    setJob(null)
    isProcessing.current = false
    setTimeout(() => setCollectionMsg(''), 6000)
  }, [])

  // ── startCollection (compatibilidade MonitoredProfileDetailPage) ──────────
  const startCollection = useCallback((profId: number, username: string, accountId: number, modeParam: string) => {
    const id = `mon-${profId}-${Date.now()}`
    const task: TaskItem = {
      id, type: 'monitored', profId, accountId, username, mode: modeParam,
      status: 'pending', message: ''
    }
    setTasks(prev => [...prev, task])
    setTimeout(processQueue, 0)
  }, [processQueue])

  // ── Enfileirar lote ───────────────────────────────────────────────────────
  const enqueueBatch = useCallback((items: Omit<TaskItem, 'id' | 'status' | 'message'>[]) => {
    const newTasks: TaskItem[] = items.map((item, i) => ({
      ...item,
      id: `batch-${Date.now()}-${i}`,
      status: 'pending',
      message: ''
    }))
    setTasks(prev => [...prev, ...newTasks])
    setTimeout(processQueue, 0)
  }, [processQueue])

  function clearMsg() { setCollectionMsg('') }

  function clearCompleted() {
    setTasks(prev => prev.filter(t => t.status === 'pending' || t.status === 'in-progress'))
  }

  function cancelPending(id: string) {
    setTasks(prev => prev.filter(t => !(t.id === id && t.status === 'pending')))
  }

  return (
    <CollectionContext.Provider value={{
      job, collecting, collectionMsg, collectProgress, lastResult,
      startCollection, clearMsg,
      tasks, enqueueBatch, clearCompleted, cancelPending
    }}>
      {children}
    </CollectionContext.Provider>
  )
}
