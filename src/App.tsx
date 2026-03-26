import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import AppLayout from './components/AppLayout'
import SetupPage from './pages/SetupPage'
import DashboardPage from './pages/DashboardPage'
import FollowersPage from './pages/FollowersPage'
import FollowingPage from './pages/FollowingPage'
import PostsPage from './pages/PostsPage'
import PostDetailPage from './pages/PostDetailPage'
import MonitoredPage from './pages/MonitoredPage'
import MonitoredProfileDetailPage from './pages/MonitoredProfileDetailPage'
import AlertsPage from './pages/AlertsPage'
import SettingsPage from './pages/SettingsPage'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { accountId, loading } = useAuth()
  if (loading) return (
    <div className="loading" style={{ minHeight: '100vh' }}>
      <div className="spinner" />
      Carregando...
    </div>
  )
  if (!accountId) return <Navigate to="/setup" replace />
  return <>{children}</>
}

function AppRoutes() {
  const { accountId } = useAuth()

  return (
    <Routes>
      <Route
        path="/setup"
        element={accountId ? <Navigate to="/dashboard" replace /> : <SetupPage />}
      />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="followers" element={<FollowersPage />} />
        <Route path="following" element={<FollowingPage />} />
        <Route path="posts" element={<PostsPage />} />
        <Route path="posts/:postId" element={<PostDetailPage />} />
        <Route path="monitored" element={<MonitoredPage />} />
        <Route path="monitored/:profileId" element={<MonitoredProfileDetailPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/setup" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </HashRouter>
  )
}
