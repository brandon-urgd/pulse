// Session UI API client
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''
const CHAT_FUNCTION_URL = import.meta.env.VITE_CHAT_FUNCTION_URL ?? ''

export interface ValidateSessionResponse {
  sessionToken: string
  sessionId: string
  tenantId: string
  item: {
    itemId: string
    itemName: string
    description: string
  }
}

export async function validateSession(params: {
  email?: string
  name?: string
  pulseCode?: string
  sessionId?: string
}): Promise<ValidateSessionResponse> {
  const res = await fetch(`${API_BASE}/api/session/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const err = new Error(body.message ?? 'Validation failed') as Error & { status: number }
    err.status = res.status
    throw err
  }

  return res.json()
}

export async function acceptConfidentiality(sessionId: string, sessionToken: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/session/${sessionId}/accept-confidentiality`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const err = new Error(body.message ?? 'Failed to accept confidentiality') as Error & { status: number }
    err.status = res.status
    throw err
  }
}

// ─── Chat API ─────────────────────────────────────────────────────────────────

export interface SessionStateResponse {
  currentSection: number
  totalSections: number
  messages: Array<{ role: 'agent' | 'reviewer'; content: string; section?: number }>
  status: string
  timeLimitMinutes: number
  files: Array<{ fileId: string; filename: string; contentType: string }>
  closingState?: 'exploring' | 'narrowing' | 'closing' | 'closed'
  itemType?: 'document' | 'image'
  imageUrl?: string | null
}

export interface ChatResponse {
  message: string
  section: number
  sessionComplete: boolean
  closingState?: 'exploring' | 'narrowing' | 'closing' | 'closed'
}

export interface SessionSummaryResponse {
  summary: {
    sections: string[]
    themes: string[]
    closingMessage: string
    tenantName?: string
  }
  tenantName?: string
}

export interface FileViewerUrlResponse {
  url: string
  contentType: string
  filename: string
  fileId: string
  originalUrl?: string
}

function makeError(body: { message?: string }, fallback: string, status: number): Error & { status: number } {
  const err = new Error(body.message ?? fallback) as Error & { status: number }
  err.status = status
  return err
}

export async function sendChatMessage(
  sessionId: string,
  sessionToken: string,
  message: string,
  windingDown?: 'true' | 'final'
): Promise<ChatResponse> {
  const res = await fetch(`${API_BASE}/api/session/${sessionId}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({ message, ...(windingDown ? { windingDown } : {}) }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw makeError(body, 'Chat request failed', res.status)
  }

  const json = await res.json()
  return json.data ?? json
}

/**
 * Send a chat message and return the raw Response for streaming consumption.
 * Uses the Lambda Function URL for response streaming (bypasses API Gateway 29s timeout).
 * Auth is passed in the request body since Function URL has no authorizer.
 */
export async function sendChatMessageStreaming(
  sessionId: string,
  sessionToken: string,
  message: string,
  windingDown?: 'true' | 'final'
): Promise<Response> {
  // Use Function URL if available, fall back to API Gateway
  const isFunctionUrl = !!CHAT_FUNCTION_URL
  const chatUrl = isFunctionUrl
    ? CHAT_FUNCTION_URL
    : `${API_BASE}/api/session/${sessionId}/chat`

  // Function URL: auth is in the body, no Authorization header needed.
  // API Gateway: auth is via Authorization header (Lambda authorizer).
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (!isFunctionUrl) {
    headers.Authorization = `Bearer ${sessionToken}`
  }

  const res = await fetch(chatUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message,
      sessionId,
      sessionToken,
      ...(windingDown ? { windingDown } : {}),
    }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw makeError(body, 'Chat request failed', res.status)
  }

  return res
}

export async function getSessionState(
  sessionId: string,
  sessionToken: string
): Promise<SessionStateResponse> {
  const res = await fetch(`${API_BASE}/api/session/${sessionId}/state`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw makeError(body, 'Failed to load session state', res.status)
  }

  const json = await res.json()
  return json.data ?? json
}

export async function getSessionSummary(
  sessionId: string,
  sessionToken: string
): Promise<SessionSummaryResponse> {
  const res = await fetch(`${API_BASE}/api/session/${sessionId}/summary`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw makeError(body, 'Failed to load session summary', res.status)
  }

  const json = await res.json()
  return json.data ?? json
}

export async function getFileViewerUrl(
  sessionId: string,
  sessionToken: string,
  fileId: string
): Promise<FileViewerUrlResponse> {
  const res = await fetch(`${API_BASE}/api/session/${sessionId}/files/${fileId}`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw makeError(body, 'Failed to get file viewer URL', res.status)
  }

  const json = await res.json()
  return json.data ?? json
}

export async function deleteSessionTranscript(
  sessionId: string,
  sessionToken: string
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/session/${sessionId}/transcript`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${sessionToken}` },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw makeError(body, 'Failed to delete session transcript', res.status)
  }
}

export async function emailSessionSummary(
  sessionId: string,
  sessionToken: string,
  email: string
): Promise<{ sent: boolean }> {
  const res = await fetch(`${API_BASE}/api/session/${sessionId}/email-summary`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({ email }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw makeError(body, 'Failed to send email', res.status)
  }

  const json = await res.json()
  return json.data ?? json
}
