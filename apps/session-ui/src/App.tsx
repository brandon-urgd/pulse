import { BrowserRouter, Routes, Route } from 'react-router-dom'
import SessionNotFound from './pages/SessionNotFound'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/s/*" element={<SessionNotFound />} />
        <Route path="*" element={<SessionNotFound />} />
      </Routes>
    </BrowserRouter>
  )
}
