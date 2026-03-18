import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initTheme } from './hooks/useTheme'
import './styles/theme.css'
import App from './App'

// Apply theme before first render to avoid flash
initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
