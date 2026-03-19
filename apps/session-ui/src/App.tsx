import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { SessionProvider } from './context/SessionContext'
import SessionValidate from './pages/SessionValidate'
import Confidentiality from './pages/Confidentiality'
import Chat from './pages/Chat'
import SessionSummary from './pages/SessionSummary'
import SessionNotFound from './pages/SessionNotFound'

export default function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          {/* /s/ — validate via pulse code query param (?code=XXXX) */}
          <Route path="/s/" element={<SessionValidate />} />
          {/* /s/:sessionId — validate via direct session link */}
          <Route path="/s/:sessionId" element={<SessionValidate />} />
          {/* /s/:sessionId/confidentiality — accept confidentiality agreement */}
          <Route path="/s/:sessionId/confidentiality" element={<Confidentiality />} />
          {/* /s/:sessionId/chat — main chat screen */}
          <Route path="/s/:sessionId/chat" element={<Chat />} />
          {/* /s/:sessionId/summary — session summary */}
          <Route path="/s/:sessionId/summary" element={<SessionSummary />} />
          {/* Catch-all for unmatched /s/* paths */}
          <Route path="/s/*" element={<SessionNotFound />} />
          <Route path="*" element={<SessionNotFound />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  )
}
