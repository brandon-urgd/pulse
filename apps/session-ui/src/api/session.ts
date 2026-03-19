// Session UI API client
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

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
