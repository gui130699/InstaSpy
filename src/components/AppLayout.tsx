import { useState, useEffect } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ProfilePopupProvider } from '../context/ProfilePopupContext'
import ProfilePopup from './ProfilePopup'
import { db } from '../db/database'

export default function AppLayout() {
  const { logout, accountId } = useAuth()
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [igUsername, setIgUsername] = useState('')
  const [igAvatar, setIgAvatar] = useState('')

  useEffect(() => {
    if (!accountId) return
    db.accounts.get(accountId).then(acc => {
      if (acc?.username) setIgUsername(acc.username)
      if (acc?.avatar_url) setIgAvatar(acc.avatar_url)
    })
  }, [accountId])

  function handleLogout() {
    logout()
    navigate('/setup')
  }

  const navItems = [
    { to: '/dashboard', icon: '📊', label: 'Dashboard' },
    { to: '/followers', icon: '👥', label: 'Seguidores' },
    { to: '/following', icon: '➡️', label: 'Seguindo' },
    { to: '/posts', icon: '📷', label: 'Posts' },
    { to: '/monitored', icon: '🔍', label: 'Perfis Monitorados' },
    { to: '/ranking', icon: '🏆', label: 'Ranking' },
    { to: '/alerts', icon: '🔔', label: 'Alertas' },
    { to: '/settings', icon: '⚙️', label: 'Configurações' }
  ]

  return (
    <ProfilePopupProvider>
      <div className="app-layout">
      {/* Overlay mobile */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 99,
            display: 'none'
          }}
          className="mobile-overlay"
        />
      )}

      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-logo">
          <span>📊</span>
          <h1>InstaMonitor</h1>
        </div>

        <nav className="sidebar-nav">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              onClick={() => setSidebarOpen(false)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            {igAvatar ? (
              <img
                src={igAvatar}
                alt={igUsername}
                style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            ) : (
              <div className="user-avatar">
                {igUsername?.charAt(0).toUpperCase() ?? 'IG'}
              </div>
            )}
            <div className="user-details">
              <div className="user-name">@{igUsername || 'conta'}</div>
              <div className="user-email">Instagram</div>
            </div>
          </div>
          <button className="btn-logout" onClick={handleLogout}>
            🛊troca
          </button>
        </div>
      </aside>

      <main className="main-content">
        <div className="topbar">
          <button
            className="hamburger"
            onClick={() => setSidebarOpen(o => !o)}
          >
            ☰
          </button>
        </div>
        <Outlet />
      </main>
      <ProfilePopup />
    </div>
    </ProfilePopupProvider>
  )
}
