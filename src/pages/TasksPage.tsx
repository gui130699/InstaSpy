import { useCollection, type TaskItem } from '../context/CollectionContext'
import { formatRelativeTime } from '../utils/formatters'

function statusBadge(status: TaskItem['status']) {
  const cfg = {
    pending:     { label: 'Aguardando',    bg: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)',    border: 'rgba(255,255,255,0.12)' },
    'in-progress': { label: '⏳ Em andamento', bg: 'rgba(102,126,234,0.15)', color: 'var(--accent-blue)',  border: 'rgba(102,126,234,0.35)' },
    done:        { label: '✅ Concluída',   bg: 'rgba(67,233,123,0.12)',  color: 'var(--accent-green)', border: 'rgba(67,233,123,0.3)'  },
    error:       { label: '❌ Erro',        bg: 'rgba(246,79,89,0.12)',   color: 'var(--accent-pink)',   border: 'rgba(246,79,89,0.3)'   },
  }[status]
  return (
    <span style={{
      fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 600,
      background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`
    }}>
      {cfg.label}
    </span>
  )
}

export default function TasksPage() {
  const { tasks, collecting, collectProgress, job, clearCompleted, cancelPending } = useCollection()

  const pending   = tasks.filter(t => t.status === 'pending')
  const active    = tasks.filter(t => t.status === 'in-progress')
  const completed = tasks.filter(t => t.status === 'done' || t.status === 'error')
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))

  const total = tasks.length
  const doneCnt = tasks.filter(t => t.status === 'done').length

  return (
    <>
      <div className="topbar">
        <h1 className="topbar-title">📋 Tarefas de Coleta</h1>
        <div className="topbar-actions">
          {total > 0 && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {doneCnt}/{total} concluídas
            </span>
          )}
          {completed.length > 0 && (
            <button className="btn btn-outline btn-sm" onClick={clearCompleted}>
              🗑️ Limpar concluídas
            </button>
          )}
        </div>
      </div>

      {total === 0 && (
        <div className="empty-state" style={{ marginTop: 48 }}>
          <span className="empty-icon">📋</span>
          <p>Nenhuma tarefa na fila.<br />Use "Coletar tudo" no Dashboard ou colete um perfil monitorado.</p>
        </div>
      )}

      {/* Em andamento */}
      {active.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header" style={{ marginBottom: 14 }}>
            <span className="card-title">⏳ Em andamento</span>
          </div>
          {active.map(t => (
            <TaskRow key={t.id} task={t} collecting={collecting} collectProgress={t.username === job?.username ? collectProgress : null} />
          ))}
        </div>
      )}

      {/* Aguardando */}
      {pending.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header" style={{ marginBottom: 14 }}>
            <span className="card-title">🕐 Aguardando ({pending.length})</span>
          </div>
          {pending.map(t => (
            <TaskRow key={t.id} task={t} onCancel={() => cancelPending(t.id)} />
          ))}
        </div>
      )}

      {/* Concluídas */}
      {completed.length > 0 && (
        <div className="card">
          <div className="card-header" style={{ marginBottom: 14 }}>
            <span className="card-title">✅ Histórico</span>
          </div>
          {completed.map(t => (
            <TaskRow key={t.id} task={t} />
          ))}
        </div>
      )}
    </>
  )
}

interface TaskRowProps {
  task: TaskItem
  collecting?: boolean
  collectProgress?: { step: string; message: string; pct: number } | null
  onCancel?: () => void
}

function TaskRow({ task, collectProgress, onCancel }: TaskRowProps) {
  const icon = task.type === 'own' ? '👤' : '🔍'
  const modes = task.mode.split(',').map(m =>
    m === 'followers' ? '👥' : m === 'following' ? '🔵' : '📷'
  ).join(' ')

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0',
      borderBottom: '1px solid rgba(255,255,255,0.05)',
    }}>
      <span style={{ fontSize: 20, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>@{task.username}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{modes}</span>
          {statusBadge(task.status)}
        </div>

        {/* Barra de progresso quando em andamento */}
        {task.status === 'in-progress' && collectProgress && (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
              {collectProgress.message}
            </div>
            <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden', maxWidth: 300 }}>
              <div style={{
                height: '100%', width: `${collectProgress.pct ?? 5}%`,
                background: 'linear-gradient(90deg, #667eea, #764ba2)',
                borderRadius: 2, transition: 'width 0.6s ease'
              }} />
            </div>
          </div>
        )}

        {/* Resultado */}
        {(task.status === 'done' || task.status === 'error') && (
          <div style={{ fontSize: 12, color: task.status === 'done' ? 'var(--accent-green)' : 'var(--accent-pink)', marginTop: 2 }}>
            {task.message}
            {task.finishedAt && (
              <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
                · {formatRelativeTime(task.finishedAt)}
              </span>
            )}
          </div>
        )}
      </div>

      {onCancel && (
        <button
          onClick={onCancel}
          style={{
            background: 'transparent', border: '1px solid rgba(246,79,89,0.3)',
            color: 'var(--accent-pink)', borderRadius: 6, padding: '2px 8px',
            fontSize: 11, cursor: 'pointer', flexShrink: 0
          }}
        >
          Cancelar
        </button>
      )}
    </div>
  )
}
