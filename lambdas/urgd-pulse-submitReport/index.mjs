// ur/gd pulse — Submit Report Lambda
// POST /api/session/{sessionId}/report (sessionAuth)
// POST /api/manage/report (cognitoAuth)
// Forwards abuse/bug/contact reports to the Command Integration intake API

import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['COMMAND_INTAKE_URL', 'COMMAND_API_KEY', 'CORS_ALLOWED_ORIGINS'])

const VALID_TYPES = new Set([
  'general-inquiry',
  'bug-report',
  'feature-request',
  'privacy-question',
  'report-abuse',
])

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  // Both authorizers pass their context — use whichever is present
  const sessionId = event?.requestContext?.authorizer?.sessionId
  const tenantId = event?.requestContext?.authorizer?.tenantId

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return errorResponse(400, 'Invalid request body', {}, origin)
  }

  const { type, message, name, email, metadata } = body

  // Validate type
  if (!type || !VALID_TYPES.has(type)) {
    return errorResponse(400, `Invalid report type. Must be one of: ${[...VALID_TYPES].join(', ')}`, {}, origin)
  }

  // Validate message
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return errorResponse(400, 'message is required', {}, origin)
  }
  if (message.length > 5000) {
    return errorResponse(400, 'Message must be 5,000 characters or fewer', {}, origin)
  }

  // Build payload — no raw PII in metadata
  const payload = {
    app: 'pulse',
    type,
    message: message.trim(),
    ...(name && typeof name === 'string' ? { name: name.trim() } : {}),
    ...(email && typeof email === 'string' ? { email: email.trim() } : {}),
    metadata: {
      ...(sessionId ? { sessionId } : {}),
      ...(tenantId ? { tenantId } : {}),
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
    },
  }

  log('info', 'SubmitReport: forwarding report', {
    requestId,
    type,
    sessionId: sessionId ?? null,
    tenantId: tenantId ?? null,
  })

  try {
    const res = await fetch(process.env.COMMAND_INTAKE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': process.env.COMMAND_API_KEY,
      },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      const upstreamStatus = res.status
      log('warn', 'SubmitReport: upstream error', { requestId, upstreamStatus, type })
      return errorResponse(502, 'Report could not be submitted. Please try again.', {}, origin)
    }

    log('info', 'SubmitReport: success', { requestId, type })
    return createResponse(200, { message: 'Report submitted successfully' }, {}, origin)
  } catch (err) {
    log('error', 'SubmitReport: fetch error', { requestId, errorName: err.name, type })
    return errorResponse(502, 'Report could not be submitted. Please try again.', {}, origin)
  }
}
