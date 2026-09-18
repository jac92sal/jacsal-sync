import { Navigate, Route, Routes } from 'react-router-dom'
import { useSession } from './lib/store'
import Login from './pages/Login'
import Projects from './pages/Projects'
import ProjectShell from './pages/ProjectShell'
import Dashboard from './pages/Dashboard'
import CadConfirm from './pages/CadConfirm'
import ObjectModel from './pages/ObjectModel'
import ChangeImpact from './pages/ChangeImpact'
import Calcs from './pages/Calcs'
import IssueGate from './pages/IssueGate'
import Settings from './pages/Settings'

export default function App() {
  const { user, loading } = useSession()
  if (loading) return <div className="h-full grid place-items-center text-muted text-sm">Loading…</div>
  if (!user) return <Login />
  return (
    <Routes>
      <Route path="/" element={<Projects />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/p/:id" element={<ProjectShell />}>
        <Route index element={<Dashboard />} />
        <Route path="cad" element={<CadConfirm />} />
        <Route path="objects" element={<ObjectModel />} />
        <Route path="changes" element={<ChangeImpact />} />
        <Route path="changes/:changeId" element={<ChangeImpact />} />
        <Route path="calcs" element={<Calcs />} />
        <Route path="gate" element={<IssueGate />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
