import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ProfilePopupProvider } from '../context/ProfilePopupContext'
import ProfilePopup from './ProfilePopup'

export default function AppLayout() {
  const { session, logout } = useAuth()
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  function handleLogout() {
    logout()
    navigate('/login')
  }

  const navItems = [
    { to: '/dashboard', icon: '📊', label: 'Dashboard' },
    { to: '/followers', icon: '👥', label: 'Seguidores' },
    { to: '/following', icon: '➡️', label: 'Seguindo' },
    { to: '/posts', icon: '📷', label: 'Posts' },
    { to: '/monitored', icon: '🔍', label: 'Perfis Monitorados' },
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
            <div className="user-avatar">
              {session?.nome?.charAt(0).toUpperCase() ?? 'U'}
            </div>
            <div className="user-details">
              <div className="user-name">{session?.nome ?? 'Usuário'}</div>
              <div className="user-email">{session?.email ?? ''}</div>
            </div>
          </div>
          <button className="btn-logout" onClick={handleLogout}>
            🚪 Sair
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
