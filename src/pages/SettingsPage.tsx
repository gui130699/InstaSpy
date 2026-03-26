import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { db } from '../db/database'
import { api } from '../services/apiClient'

export default function SettingsPage() {
  const { session, accountId } = useAuth()
  const navigate = useNavigate()
  const [exported, setExported] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [msg, setMsg] = useState('')
  const [serverOnline, setServerOnline] = useState<boolean | null>(null)
  const [accountMode, setAccountMode] = useState<'real' | 'demo' | null>(null)
  const [collectInterval, setCollectInterval] = useState<number>(
    Number(localStorage.getItem('collect_interval_h') || '24')
  )

  useEffect(() => {
    api.isOnline().then(setServerOnline)
    if (accountId) {
      db.accounts.get(accountId).then(acc => {
        setAccountMode(acc?.serialized_session ? 'real' : 'demo')
      })
    }
  }, [accountId])

  async function exportData() {
    if (!accountId) return

    const [snapshots, posts, postSnaps, alerts] = await Promise.all([
      db.snapshots.where('account_id').equals(accountId).toArray(),
      db.posts.where('account_id').equals(accountId).toArray(),
      db.post_snapshots.where('account_id').equals(accountId).toArray(),
      db.alerts.where('account_id').equals(accountId).toArray()
    ])

    const data = { snapshots, posts, post_snapshots: postSnaps, alerts, exported_at: new Date().toISOString() }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `instamonitor_export_${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
    setExported(true)
    setTimeout(() => setExported(false), 3000)
  }

  async function clearHistory() {
    if (!accountId) return
    if (!confirm('Apagar todo o histórico de snapshots e alertas? Esta ação não pode ser desfeita.')) return
    setClearing(true)

    try {
      await Promise.all([
        db.snapshots.where('account_id').equals(accountId).delete(),
        db.post_snapshots.where('account_id').equals(accountId).delete(),
        db.alerts.where('account_id').equals(accountId).delete()
      ])
      setMsg('✅ Histórico limpo com sucesso')
    } catch {
      setMsg('❌ Erro ao limpar histórico')
    } finally {
      setClearing(false)
      setTimeout(() => setMsg(''), 3000)
    }
  }

  return (
    <>
      <div className="topbar">
        <h1 className="topbar-title">⚙️ Configurações</h1>
      </div>

      {msg && (
        <div style={{
          padding: '10px 14px',
          background: msg.startsWith('✅') ? 'rgba(67,233,123,0.1)' : 'rgba(246,79,89,0.1)',
          border: `1px solid ${msg.startsWith('✅') ? 'rgba(67,233,123,0.3)' : 'rgba(246,79,89,0.3)'}`,
          borderRadius: 8, fontSize: 13, marginBottom: 20,
          color: msg.startsWith('✅') ? 'var(--accent-green)' : 'var(--accent-pink)'
        }}>
          {msg}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Conta */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">👤 Sua conta</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Row label="Nome" value={session?.nome ?? '—'} />
            <Row label="E-mail" value={session?.email ?? '—'} />
            <Row label="ID da conta" value={String(accountId ?? '—')} />
          </div>
        </div>

        {/* Instagram */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">📷 Conexão com Instagram</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Modo</span>
              <span style={{
                fontSize: 12, padding: '2px 8px', borderRadius: 4, fontWeight: 600,
                background: accountMode === 'real' ? 'rgba(67,233,123,0.15)' : 'rgba(102,126,234,0.15)',
                color: accountMode === 'real' ? 'var(--accent-green)' : 'var(--accent-blue)',
                border: `1px solid ${accountMode === 'real' ? 'rgba(67,233,123,0.3)' : 'rgba(102,126,234,0.3)'}`
              }}>
                {accountMode === 'real' ? '🔐 REAL' : accountMode === 'demo' ? '🎭 DEMO' : '—'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Servidor backend</span>
              <span style={{ fontSize: 13, color: serverOnline ? 'var(--accent-green)' : 'var(--accent-pink)', fontWeight: 600 }}>
                {serverOnline === null ? '—' : serverOnline ? '✅ Online' : '❌ Offline'}
              </span>
            </div>
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => navigate('/setup')}
            >
              🔄 Reconectar Instagram
            </button>
            <button
              className="btn btn-sm"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}
              onClick={() => api.isOnline().then(setServerOnline)}
            >
              🔍 Verificar servidor
            </button>
          </div>
          {!serverOnline && accountMode === 'real' && (
            <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(246,79,89,0.08)', borderRadius: 6, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
              <strong>Para iniciar o servidor:</strong><br />
              <code style={{ background: 'rgba(0,0,0,0.2)', padding: '4px 6px', borderRadius: 4, display: 'block', marginTop: 4 }}>
                cd server &amp;&amp; npm install &amp;&amp; node index.js
              </code>
            </div>
          )}
        </div>

        {/* Coleta automática */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">⏱️ Intervalo de coleta</span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
            Tempo entre coletas automáticas. Valores menores aumentam o risco de bloqueio pelo Instagram.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="number"
              min={1}
              max={168}
              value={collectInterval}
              onChange={e => {
                const v = Math.max(1, Number(e.target.value))
                setCollectInterval(v)
                localStorage.setItem('collect_interval_h', String(v))
              }}
              style={{ width: 80, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 14, textAlign: 'center' }}
            />
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>hora(s) entre coletas</span>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
            Recomendado: 24h. Mínimo: 1h. Use o botão "Coletar agora" no Dashboard para coleta manual.
          </p>
        </div>

        {/* Exportação */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">📤 Exportar dados</span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
            Exporta todos os snapshots, posts e alertas em formato JSON para backup local.
          </p>
          <button className="btn btn-primary" onClick={exportData}>
            {exported ? '✅ Exportado!' : '⬇️ Baixar JSON'}
          </button>
        </div>

        {/* Limpar dados */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">🗑 Gerenciar dados</span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
            Apaga o histórico de coletas. A conta e posts serão mantidos, apenas snapshots e alertas serão removidos.
          </p>
          <button
            className="btn btn-danger"
            onClick={clearHistory}
            disabled={clearing}
          >
            {clearing ? '⏳ Limpando...' : '🗑 Limpar histórico'}
          </button>
        </div>

        {/* Info PWA */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">📱 Sobre o app</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Row label="Versão" value="1.0.0" />
            <Row label="Armazenamento" value="IndexedDB (local)" />
            <Row label="Modo" value="Offline-first PWA" />
            <Row label="Coleta" value={accountMode === 'real' ? 'Instagram API (real)' : 'Simulada (demo)'} />
          </div>
        </div>
      </div>
    </>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{label}</span>
      <span style={{ fontWeight: 600, fontSize: 13 }}>{value}</span>
    </div>
  )
}
