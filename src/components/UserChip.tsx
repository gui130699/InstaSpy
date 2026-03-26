import { useProfilePopup } from '../context/ProfilePopupContext'

interface UserChipProps {
  username: string
  /** Badge opcional exibido à direita (ex: "Novo", "Saiu") */
  badge?: React.ReactNode
  /** Modo compacto para listas densas */
  compact?: boolean
}

/** Linha de usuário clicável que abre o popup de perfil */
export default function UserChip({ username, badge, compact = false }: UserChipProps) {
  const { openProfile } = useProfilePopup()

  return (
    <li
      className="user-list-item"
      style={{ cursor: 'pointer' }}
      onClick={() => openProfile(username)}
      title={`Ver perfil de @${username}`}
    >
      <div
        className="user-list-avatar"
        style={{
          background: 'linear-gradient(135deg, rgba(102,126,234,0.3), rgba(118,75,162,0.3))',
          fontSize: compact ? 11 : 13,
        }}
      >
        {username.charAt(0).toUpperCase()}
      </div>
      <span style={{ fontSize: compact ? 12 : 13 }}>@{username}</span>
      {badge && <span style={{ marginLeft: 'auto' }}>{badge}</span>}
      <span style={{
        marginLeft: badge ? 6 : 'auto',
        fontSize: 10,
        color: 'var(--text-muted)',
        opacity: 0.5,
      }}>›</span>
    </li>
  )
}
