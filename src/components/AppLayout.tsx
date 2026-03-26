import { useState, useEffect } from 'react'
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useCollection } from '../context/CollectionContext'
import { ProfilePopupProvider } from '../context/ProfilePopupContext'
import ProfilePopup from './ProfilePopup'
import { db } from '../db/database'

export default function AppLayout() {
  const { logout, accountId, accounts, switchAccount } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { collecting, job: collectionJob, collectProgress } = useCollection()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showSwitcher, setShowSwitcher] = useState(false)
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
    { to: '/tasks', icon: '📋', label: 'Tarefas' },
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

      {/* Overlay para fechar seletor de contas */}
      {showSwitcher && (
        <div
          onClick={() => setShowSwitcher(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 199 }}
        />
      )}

      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-logo">
          <span role="img" aria-label="logo">📊</span>
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

        <div className="sidebar-footer" style={{ position: 'relative' }}>
          {/* Seletor de contas */}
          {showSwitcher && (
            <div style={{
              position: 'absolute',
              bottom: 'calc(100% + 6px)',
              left: 0,
              right: 0,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius)',
              overflow: 'hidden',
              zIndex: 200,
              boxShadow: '0 -8px 32px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.06)',
            }}>
              <div style={{ padding: '10px 12px 6px', fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Contas conectadas
              </div>
              {accounts.map(acc => (
                <button key={acc.id}
                  onClick={() => { switchAccount(acc.id!); setShowSwitcher(false) }}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 9,
                    padding: '8px 12px',
                    background: acc.id === accountId ? 'var(--brand-dim)' : 'transparent',
                    border: 'none', cursor: 'pointer', color: 'var(--text-primary)',
                    transition: 'background 0.15s',
                  }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 8,
                    background: 'var(--bg-overlay)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, overflow: 'hidden', flexShrink: 0,
                    border: acc.id === accountId ? '1.5px solid var(--brand)' : '1.5px solid var(--border-color)',
                  }}>
                    {acc.avatar_url
                      ? <img src={acc.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      : acc.username?.charAt(0).toUpperCase() ?? 'I'}
                  </div>
                  <span style={{ fontSize: 12.5, flex: 1, textAlign: 'left', fontWeight: acc.id === accountId ? 600 : 400, letterSpacing: '-0.1px' }}>
                    @{acc.username}
                  </span>
                  {acc.id === accountId && (
                    <span style={{ color: 'var(--color-success)', fontSize: 12, fontWeight: 700 }}>✓</span>
                  )}
                </button>
              ))}
              <div style={{ height: 1, background: 'var(--border-color)', margin: '4px 8px' }} />
              <button
                onClick={() => { navigate('/setup?new=1'); setShowSwitcher(false) }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 9,
                  padding: '9px 12px 11px', background: 'transparent', border: 'none',
                  cursor: 'pointer', color: 'var(--brand)', fontSize: 12.5, fontWeight: 600,
                }}>
                <span style={{ fontSize: 13 }}>＋</span>
                Adicionar conta
              </button>
            </div>
          )}

          <div className="user-info" style={{ cursor: 'pointer', flex: 1, minWidth: 0 }}
            onClick={() => setShowSwitcher(o => !o)}>
            {igAvatar ? (
              <img
                src={igAvatar}
                alt={igUsername}
                style={{ width: 32, height: 32, borderRadius: 9, objectFit: 'cover', flexShrink: 0, border: '1.5px solid var(--border-strong)' }}
                onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            ) : (
              <div className="user-avatar">
                {igUsername?.charAt(0).toUpperCase() ?? 'IG'}
              </div>
            )}
            <div className="user-details" style={{ flex: 1, minWidth: 0 }}>
              <div className="user-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                @{igUsername || 'conta'} {accounts.length > 1 && <span style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1 }}>{showSwitcher ? '▲' : '▼'}</span>}
              </div>
              <div className="user-email">{accounts.length > 1 ? `${accounts.length} contas` : 'Instagram'}</div>
            </div>
          </div>
          <button className="btn-logout" title="Adicionar conta" onClick={() => navigate('/setup?new=1')}>
            ＋
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
        {/* Banner de coleta em andamento */}
        {collecting && collectionJob && !location.pathname.includes(`/monitored/${collectionJob.profId}`) && (
          <div style={{
            background: 'linear-gradient(90deg, var(--brand-dim), transparent)',
            border: '1px solid var(--border-brand)',
            borderRadius: 'var(--radius-sm)',
            padding: '10px 14px',
            marginBottom: 18,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}>
            <div className="spinner" style={{ width: 13, height: 13, flexShrink: 0 }} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--brand)' }}>
              Coletando @{collectionJob.username}...
            </span>
            {collectProgress && (
              <>
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {collectProgress.message}
                </span>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 72, height: 3, background: 'var(--border-color)', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${collectProgress.pct}%`,
                      background: 'var(--gradient-brand)',
                      borderRadius: 99,
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
        <Outlet key={accountId ?? 'none'} />
      </main>
      <ProfilePopup />
    </div>
    </ProfilePopupProvider>
  )
}
