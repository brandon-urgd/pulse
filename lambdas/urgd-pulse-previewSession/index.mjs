// ur/gd pulse — Preview Session Lambda
// GET /api/manage/items/{itemId}/preview-session
// Creates a short-lived (15-min TTL), non-persisted preview session token
// scoped to the requesting tenant. Preview sessions are excluded from all
// reports, pulse checks, and session counts.

import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { randomUUID, randomBytes } from 'crypto'

requireEnv(['SESSIONS_TABLE', 'ITEMS_TABLE', 'CORS_ALLOWED_ORIGINS', 'APP_URL'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

const PREVIEW_TTL_SECONDS = 15 * 60 // 15 minutes

/**
 * Generates a unique 8-character alphanumeric pulse code (same charset as inviteReviewer).
 */
function generatePulseCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  const bytes = randomBytes(8)
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length]
  }
  return code
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) {
    log('warn', 'PreviewSession: missing tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!itemId) {
    return errorResponse(400, 'itemId is required', {}, origin)
  }

  try {
    // Verify item exists and belongs to this tenant
    const itemResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
      },
    }))

    if (!itemResult.Item) {
      log('warn', 'PreviewSession: item not found', { requestId, tenantId, itemId })
      return errorResponse(404, 'Item not found', {}, origin)
    }

    // Belt-and-suspenders: verify tenant ownership
    if (itemResult.Item.tenantId?.S !== tenantId) {
      log('warn', 'PreviewSession: tenant mismatch', { requestId, tenantId, itemId })
      return errorResponse(404, 'Item not found', {}, origin)
    }

    // Accept optional timeLimitMinutes from request body (1–60 min)
    let body = {}
    try { body = JSON.parse(event.body || '{}') } catch { /* ignore */ }
    const rawLimit = Number(body.timeLimitMinutes)
    const timeLimitMinutes = (!isNaN(rawLimit) && rawLimit >= 1 && rawLimit <= 60)
      ? Math.round(rawLimit)
      : (parseInt(itemResult.Item.recommendedTimeLimitMinutes?.N || '0', 10) || 30)

    const sessionId = randomUUID()
    const pulseCode = generatePulseCode()
    const now = new Date()
    const expiresAtEpoch = Math.floor(now.getTime() / 1000) + PREVIEW_TTL_SECONDS
    const expiresAtIso = new Date(expiresAtEpoch * 1000).toISOString()

    // Create preview session record — preview: true flag marks it as non-persisted
    // and excluded from all reports, pulse checks, and session counts
    await dynamo.send(new PutItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Item: {
        tenantId: { S: tenantId },
        sessionId: { S: sessionId },
        itemId: { S: itemId },
        pulseCode: { S: pulseCode },
        status: { S: 'not_started' },
        preview: { BOOL: true },
        timeLimitMinutes: { N: String(timeLimitMinutes) },
        expiresAt: { S: expiresAtIso },
        // DynamoDB TTL attribute (epoch seconds) for automatic cleanup
        ttl: { N: String(expiresAtEpoch) },
        createdAt: { S: now.toISOString() },
        updatedAt: { S: now.toISOString() },
      },
    }))

    const previewUrl = `${process.env.APP_URL}/s/?code=${pulseCode}&preview=true`

    log('info', 'PreviewSession: created', { requestId, tenantId, itemId, sessionId })

    return createResponse(200, {
      data: {
        previewUrl,
        sessionId,
        pulseCode,
        expiresAt: expiresAtIso,
      },
    }, {}, origin)
  } catch (err) {
    log('error', 'PreviewSession: unexpected error', {
      requestId, tenantId, itemId,
      errorName: err.name,
      errorMessage: err.message,
    })
    return errorResponse(500, 'Failed to create preview session', {}, origin)
  }
}
