import { useState, useEffect } from 'react'
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useCollection } from '../context/CollectionContext'
import { ProfilePopupProvider } from '../context/ProfilePopupContext'
import ProfilePopup from './ProfilePopup'
import { db } from '../db/database'

export default function AppLayout() {
  const { logout, accountId } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { collecting, job: collectionJob, collectProgress } = useCollection()
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
        {/* Banner de coleta em andamento (visível ao navegar para outra página) */}
        {collecting && collectionJob && !location.pathname.includes(`/monitored/${collectionJob.profId}`) && (
          <div style={{
            background: 'rgba(102,126,234,0.12)',
            border: '1px solid rgba(102,126,234,0.3)',
            borderRadius: 10,
            padding: '10px 16px',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}>
            <div className="spinner" style={{ width: 14, height: 14, flexShrink: 0 }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent-blue)' }}>
              Coletando @{collectionJob.username}...
            </span>
            {collectProgress && (
              <>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {collectProgress.message}
                </span>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 80, height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${collectProgress.pct}%`,
                      background: 'linear-gradient(90deg, #667eea, #764ba2)',
                      borderRadius: 2,
                      transition: 'width 0.6s ease',
                    }} />
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                    {collectProgress.pct}%
                  </span>
                </div>
              </>
            )}
          </div>
        )}
        <Outlet />
      </main>
      <ProfilePopup />
    </div>
    </ProfilePopupProvider>
  )
}
