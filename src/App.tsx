import { Routes, Route, Navigate } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { MobileBlocker } from '@/components/layout/MobileBlocker'
import { Toaster } from '@/components/ui/toaster'
import { LaundromaPage } from '@/features/laundromat/LaundromaPage'
import { DiffPage } from '@/features/diff/DiffPage'
import { MatcherPage } from '@/features/matcher/MatcherPage'
import { ScrubberPage } from '@/features/scrubber/ScrubberPage'

function App() {
  return (
    <>
      <MobileBlocker />
      <AppShell>
        <Routes>
          <Route path="/" element={<Navigate to="/laundromat" replace />} />
          <Route path="/laundromat" element={<LaundromaPage />} />
          <Route path="/diff" element={<DiffPage />} />
          <Route path="/matcher" element={<MatcherPage />} />
          <Route path="/scrubber" element={<ScrubberPage />} />
        </Routes>
      </AppShell>
      <Toaster />
    </>
  )
}

export default App
