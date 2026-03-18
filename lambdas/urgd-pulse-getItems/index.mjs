// ur/gd pulse — Get Items Lambda (S1 stub)
// GET /api/manage/items → returns empty array (full implementation in S2)

import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

// Fail-fast env var validation
requireEnv(['ITEMS_TABLE', 'CORS_ALLOWED_ORIGINS'])

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId

  if (!tenantId) {
    log('warn', 'GetItems: missing tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  log('info', 'GetItems: returning stub response', { requestId, tenantId })

  return createResponse(200, { data: [] }, {}, origin)
}
