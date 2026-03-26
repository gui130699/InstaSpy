import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { api } from '../services/apiClient'
import { runRealMonitoredCollection } from '../services/realCollector'
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

interface CollectionContextType {
  job: CollectionJob | null
  collecting: boolean
  collectionMsg: string
  collectProgress: CollectionProgress | null
  lastResult: CollectionResult | null
  startCollection: (profId: number, username: string, accountId: number, modeParam: string) => void
  clearMsg: () => void
}

const CollectionContext = createContext<CollectionContextType>({
  job: null,
  collecting: false,
  collectionMsg: '',
  collectProgress: null,
  lastResult: null,
  startCollection: () => {},
  clearMsg: () => {}
})

export function useCollection() {
  return useContext(CollectionContext)
}

export function CollectionProvider({ children }: { children: ReactNode }) {
  const [job, setJob] = useState<CollectionJob | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [collectionMsg, setCollectionMsg] = useState('')
  const [collectProgress, setCollectProgress] = useState<CollectionProgress | null>(null)
  const [lastResult, setLastResult] = useState<CollectionResult | null>(null)

  const isCollecting = useRef(false)
  const accountIdRef = useRef<number | null>(null)

  // Polling de progresso enquanto coleta
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
          setCollectProgress({
            step: p.step,
            message: p.message ?? '',
            pct: p.pct ?? 0,
            latestUsers: p.latestUsers
          })
        }
      } catch { /* ignora */ }
    }, 2000)
    return () => clearInterval(interval)
  }, [collecting])

  const startCollection = useCallback((profId: number, username: string, accountId: number, modeParam: string) => {
    if (isCollecting.current) return

    isCollecting.current = true
    accountIdRef.current = accountId
    setJob({ profId, username })
    setCollecting(true)
    setCollectionMsg('')
    setLastResult(null)

    runRealMonitoredCollection(profId, accountId, modeParam)
      .then(result => {
        setLastResult(result)
        const total =
          result.newFollowers.length + result.lostFollowers.length +
          result.newFollowing.length + result.lostFollowing.length
        setCollectionMsg(`✅ Coleta concluída — ${total} mudança(s) detectada(s)`)
        setTimeout(() => setCollectionMsg(''), 6000)
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : 'Erro na coleta'
        setCollectionMsg(`❌ ${msg}`)
      })
      .finally(() => {
        isCollecting.current = false
        setCollecting(false)
      })
  }, [])

  function clearMsg() {
    setCollectionMsg('')
  }

  return (
    <CollectionContext.Provider value={{ job, collecting, collectionMsg, collectProgress, lastResult, startCollection, clearMsg }}>
      {children}
    </CollectionContext.Provider>
  )
}
