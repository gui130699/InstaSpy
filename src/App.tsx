import { HashRouter, Routes, Route, Navigate, useSearchParams } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { CollectionProvider } from './context/CollectionContext'
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
import RankingPage from './pages/RankingPage'
import TasksPage from './pages/TasksPage'

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

// Permite acesso a /setup?new=1 mesmo autenticado
function SetupGuard() {
  const { accountId } = useAuth()
  const [searchParams] = useSearchParams()
  const isNew = searchParams.get('new') === '1'
  if (accountId && !isNew) return <Navigate to="/dashboard" replace />
  return <SetupPage />
}

function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/setup"
        element={<SetupGuard />}
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
        <Route path="ranking" element={<RankingPage />} />
        <Route path="tasks" element={<TasksPage />} />
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
        <CollectionProvider>
          <AppRoutes />
        </CollectionProvider>
      </AuthProvider>
    </HashRouter>
  )
}
