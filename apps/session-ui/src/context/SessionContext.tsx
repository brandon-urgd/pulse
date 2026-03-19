// Session token context — stores the reviewer's session token in memory + sessionStorage
import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'

interface SessionContextValue {
  sessionToken: string | null
  sessionId: string | null
  setSession: (token: string, sessionId: string) => void
  clearSession: () => void
}

const SessionContext = createContext<SessionContextValue | null>(null)

const STORAGE_KEY = 'pulse_session_token'
const SESSION_ID_KEY = 'pulse_session_id'

export function SessionProvider({ children }: { children: ReactNode }) {
  const [sessionToken, setSessionToken] = useState<string | null>(
    () => sessionStorage.getItem(STORAGE_KEY)
  )
  const [sessionId, setSessionId] = useState<string | null>(
    () => sessionStorage.getItem(SESSION_ID_KEY)
  )

  const setSession = (token: string, id: string) => {
    sessionStorage.setItem(STORAGE_KEY, token)
    sessionStorage.setItem(SESSION_ID_KEY, id)
    setSessionToken(token)
    setSessionId(id)
  }

  const clearSession = () => {
    sessionStorage.removeItem(STORAGE_KEY)
    sessionStorage.removeItem(SESSION_ID_KEY)
    setSessionToken(null)
    setSessionId(null)
  }

  return (
    <SessionContext.Provider value={{ sessionToken, sessionId, setSession, clearSession }}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within SessionProvider')
  return ctx
}
