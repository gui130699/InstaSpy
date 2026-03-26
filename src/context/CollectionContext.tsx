import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { api } from '../services/apiClient'
import { runRealMonitoredCollection, runRealCollection } from '../services/realCollector'
import { db } from '../db/database'

// ─── Tipos ────────────────────────────────────────────────────────────────────

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

export type TaskStatus = 'pending' | 'in-progress' | 'done' | 'error'
export type TaskType = 'own' | 'monitored'

export interface TaskItem {
  id: string
  type: TaskType
  profId?: number
  accountId: number
  username: string
  mode: string
  status: TaskStatus
  message: string
  startedAt?: number
  finishedAt?: number
  result?: { total: number }
}

// ─── Contexto ─────────────────────────────────────────────────────────────────

interface CollectionContextType {
  job: CollectionJob | null
  collecting: boolean
  collectionMsg: string
  collectProgress: CollectionProgress | null
  lastResult: CollectionResult | null
  startCollection: (profId: number, username: string, accountId: number, modeParam: string) => void
  clearMsg: () => void
  tasks: TaskItem[]
  enqueueBatch: (items: Omit<TaskItem, 'id' | 'status' | 'message'>[]) => void
  clearCompleted: () => void
  cancelPending: (id: string) => void
}

const CollectionContext = createContext<CollectionContextType>({
  job: null, collecting: false, collectionMsg: '', collectProgress: null, lastResult: null,
  startCollection: () => {}, clearMsg: () => {},
  tasks: [], enqueueBatch: () => {}, clearCompleted: () => {}, cancelPending: () => {}
})

export function useCollection() { return useContext(CollectionContext) }

// ─── Provider ─────────────────────────────────────────────────────────────────
/**
 * Arquitetura: fila imperativa (refs) + estado React só para renderização.
 *
 * Bug anterior: tasksRef era sincronizado via useEffect, mas processQueue era
 * chamado via setTimeout antes do React re-renderizar, deixando a ref vazia.
 * Agora pendingQueue.current é mutado diretamente — zero dependência de renders.
 */
export function CollectionProvider({ children }: { children: ReactNode }) {

  // ── Estado React — apenas para UI ─────────────────────────────────────────
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [job, setJob] = useState<CollectionJob | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [collectionMsg, setCollectionMsg] = useState('')
  const [collectProgress, setCollectProgress] = useState<CollectionProgress | null>(null)
  const [lastResult, setLastResult] = useState<CollectionResult | null>(null)

  // ── Refs imperativas — não dependem do ciclo de render ────────────────────
  const isProcessing = useRef(false)
  const pendingQueue = useRef<TaskItem[]>([])           // fila de execução pendente
  const allTasks = useRef(new Map<string, TaskItem>())  // todos os tasks (para exibir)
  const accountIdRef = useRef<number | null>(null)

  // ── Helpers ───────────────────────────────────────────────────────────────
  function syncDisplay() {
    setTasks([...allTasks.current.values()])
  }

  function updateTask(id: string, updates: Partial<TaskItem>) {
    const t = allTasks.current.get(id)
    if (t) {
      allTasks.current.set(id, { ...t, ...updates })
      syncDisplay()
    }
  }

  // ── Polling de progresso ──────────────────────────────────────────────────
  useEffect(() => {
    if (!collecting) { setCollectProgress(null); return }
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

  // ── Processador de fila — opera nas refs, não no React state ──────────────
  const processQueue = useCallback(async () => {
    if (isProcessing.current) return
    isProcessing.current = true

    while (pendingQueue.current.length > 0) {
      const task = pendingQueue.current.shift()!

      accountIdRef.current = task.accountId
      updateTask(task.id, { status: 'in-progress', startedAt: Date.now() })
      setJob({ profId: task.profId ?? 0, username: task.username })
      setCollecting(true)
      setCollectionMsg('')
      setLastResult(null)

      try {
        if (task.type === 'monitored' && task.profId != null) {
          const result = await runRealMonitoredCollection(task.profId, task.accountId, task.mode)
          const total = result.newFollowers.length + result.lostFollowers.length +
            result.newFollowing.length + result.lostFollowing.length
          setLastResult(result)
          const msg = `✅ ${total} mudança(s)`
          setCollectionMsg(`✅ @${task.username} — ${total} mudança(s)`)
          updateTask(task.id, { status: 'done', message: msg, finishedAt: Date.now(), result: { total } })
        } else {
          const result = await runRealCollection(task.accountId, task.mode)
          const total =
            result.followersDiff.newFollowers.length + result.followersDiff.lostFollowers.length +
            result.likerDiffs.reduce((a, d) => a + d.newLikers.length + d.lostLikers.length, 0)
          setLastResult({
            newFollowers: result.followersDiff.newFollowers,
            lostFollowers: result.followersDiff.lostFollowers,
            newFollowing: result.followersDiff.newFollowing,
            lostFollowing: result.followersDiff.lostFollowing
          })
          const msg = `✅ ${total} evento(s)`
          setCollectionMsg(`✅ @${task.username} — ${total} evento(s)`)
          updateTask(task.id, { status: 'done', message: msg, finishedAt: Date.now(), result: { total } })
        }
      } catch (err) {
        const msg = `❌ ${err instanceof Error ? err.message : 'Erro'}`
        setCollectionMsg(msg)
        updateTask(task.id, { status: 'error', message: msg, finishedAt: Date.now() })
      }

      // Pausa entre tarefas para não sobrecarregar o Instagram
      if (pendingQueue.current.length > 0) {
        await new Promise(r => setTimeout(r, 3000))
      }
    }

    setCollecting(false)
    setJob(null)
    isProcessing.current = false
    setTimeout(() => setCollectionMsg(''), 6000)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── API pública ───────────────────────────────────────────────────────────

  const startCollection = useCallback((profId: number, username: string, accountId: number, modeParam: string) => {
    // Deduplicação: ignora se já existe tarefa pendente/em-progresso para este perfil
    const duplicate = [...allTasks.current.values()].some(
      t => t.profId === profId && (t.status === 'pending' || t.status === 'in-progress')
    )
    if (duplicate) return

    const id = `mon-${profId}-${Date.now()}`
    const task: TaskItem = {
      id, type: 'monitored', profId, accountId, username,
      mode: modeParam, status: 'pending', message: ''
    }
    allTasks.current.set(id, task)
    pendingQueue.current.push(task)
    syncDisplay()
    processQueue()
  }, [processQueue])

  const enqueueBatch = useCallback((items: Omit<TaskItem, 'id' | 'status' | 'message'>[]) => {
    // IDs de perfis já pendentes/em-progresso para deduplicação
    const activeProfIds = new Set(
      [...allTasks.current.values()]
        .filter(t => t.status === 'pending' || t.status === 'in-progress')
        .map(t => t.profId)
    )
    items.forEach((item, i) => {
      // Pula se já há tarefa ativa para este perfil
      if (item.profId != null && activeProfIds.has(item.profId)) return
      activeProfIds.add(item.profId) // marca como agendado para este batch
      const id = `batch-${Date.now()}-${i}`
      const task: TaskItem = { ...item, id, status: 'pending', message: '' }
      allTasks.current.set(id, task)
      pendingQueue.current.push(task)
    })
    syncDisplay()
    processQueue()
  }, [processQueue])

  function clearMsg() { setCollectionMsg('') }

  function clearCompleted() {
    for (const [id, t] of allTasks.current.entries()) {
      if (t.status === 'done' || t.status === 'error') allTasks.current.delete(id)
    }
    syncDisplay()
  }

  function cancelPending(id: string) {
    const t = allTasks.current.get(id)
    if (t?.status === 'pending') {
      allTasks.current.delete(id)
      pendingQueue.current = pendingQueue.current.filter(q => q.id !== id)
      syncDisplay()
    }
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
