// Session token context — stores the reviewer's session token in memory + sessionStorage
import { createContext, useContext, useState, type ReactNode } from 'react'

interface SessionContextValue {
  sessionToken: string | null
  sessionId: string | null
  itemName: string | null
  setSession: (token: string, sessionId: string, itemName: string) => void
  clearSession: () => void
}

const SessionContext = createContext<SessionContextValue | null>(null)

const STORAGE_KEY = 'pulse_session_token'
const SESSION_ID_KEY = 'pulse_session_id'
const ITEM_NAME_KEY = 'pulse_item_name'

export function SessionProvider({ children }: { children: ReactNode }) {
  const [sessionToken, setSessionToken] = useState<string | null>(
    () => sessionStorage.getItem(STORAGE_KEY)
  )
  const [sessionId, setSessionId] = useState<string | null>(
    () => sessionStorage.getItem(SESSION_ID_KEY)
  )
  const [itemName, setItemName] = useState<string | null>(
    () => sessionStorage.getItem(ITEM_NAME_KEY)
  )

  const setSession = (token: string, id: string, name: string) => {
    sessionStorage.setItem(STORAGE_KEY, token)
    sessionStorage.setItem(SESSION_ID_KEY, id)
    sessionStorage.setItem(ITEM_NAME_KEY, name)
    setSessionToken(token)
    setSessionId(id)
    setItemName(name)
  }

  const clearSession = () => {
    sessionStorage.removeItem(STORAGE_KEY)
    sessionStorage.removeItem(SESSION_ID_KEY)
    sessionStorage.removeItem(ITEM_NAME_KEY)
    setSessionToken(null)
    setSessionId(null)
    setItemName(null)
  }

  return (
    <SessionContext.Provider value={{ sessionToken, sessionId, itemName, setSession, clearSession }}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used within SessionProvider')
  return ctx
}
