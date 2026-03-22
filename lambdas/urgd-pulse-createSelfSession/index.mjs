// ur/gd pulse — Create Self-Review Session Lambda
// POST /api/manage/items/{itemId}/self-review
// Creates a session where the tenant is both the item owner and the reviewer.
// No email, no pulse code, no SES — the Cognito JWT is the identity proof.
// Sets isSelfReview: true on the session record.
// Generates a session token directly and returns { sessionId, sessionUrl }.

import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { randomUUID } from 'crypto'

requireEnv(['SESSIONS_TABLE', 'ITEMS_TABLE', 'CORS_ALLOWED_ORIGINS', 'APP_URL'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

const DEFAULT_MAX_SESSIONS_FREE = 5
const DEFAULT_MAX_SESSIONS_PAID = 50

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) {
    log('warn', 'CreateSelfSession: missing tenantId in authorizer context', { requestId })
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
      log('warn', 'CreateSelfSession: item not found', { requestId, tenantId, itemId })
      return errorResponse(404, 'Item not found', {}, origin)
    }

    // Belt-and-suspenders: verify tenant ownership
    if (itemResult.Item.tenantId?.S !== tenantId) {
      log('warn', 'CreateSelfSession: tenant mismatch', { requestId, tenantId, itemId })
      return errorResponse(404, 'Item not found', {}, origin)
    }

    const itemStatus = itemResult.Item.status?.S
    const closeDate = itemResult.Item.closeDate?.S

    // Self-review only allowed for draft and active items
    if (itemStatus !== 'draft' && itemStatus !== 'active') {
      log('warn', 'CreateSelfSession: item not in draft or active status', { requestId, tenantId, itemId, itemStatus })
      return errorResponse(409, 'Self-review is only available for draft and active items', {}, origin)
    }

    // Accept optional timeLimitMinutes from request body (1–60 min)
    // Snap to bracket midpoints: 12, 17, 25, 37. Default to 17 (15–20 min) if not set.
    let body = {}
    try { body = JSON.parse(event.body || '{}') } catch { /* ignore */ }
    const BRACKETS = [12, 17, 25, 37]
    const rawLimit = Number(body.timeLimitMinutes)
    const rawItemMinutes = parseInt(itemResult.Item.recommendedTimeLimitMinutes?.N || '0', 10)
    const resolvedRaw = (!isNaN(rawLimit) && rawLimit >= 1) ? rawLimit : (rawItemMinutes || 17)
    const timeLimitMinutes = BRACKETS.reduce((best, b) =>
      Math.abs(b - resolvedRaw) < Math.abs(best - resolvedRaw) ? b : best, BRACKETS[0])

    // Check for an existing self-review session — if found, return 409 with existingSessionId
    // so the frontend can offer a "start over" flow
    const existingSessionsResult = await dynamo.send(new QueryCommand({
      TableName: process.env.SESSIONS_TABLE,
      IndexName: 'item-index',
      KeyConditionExpression: 'itemId = :iid',
      FilterExpression: 'isSelfReview = :t AND #st <> :cancelled',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':iid': { S: itemId },
        ':t': { BOOL: true },
        ':cancelled': { S: 'cancelled' },
      },
    }))

    const existingSelfReview = (existingSessionsResult.Items ?? [])[0]
    if (existingSelfReview) {
      const existingSessionId = existingSelfReview.sessionId?.S
      log('info', 'CreateSelfSession: existing self-review found', { requestId, tenantId, itemId, existingSessionId })
      return errorResponse(409, 'A self-review session already exists for this item.', { existingSessionId }, origin)
    }

    // Count all sessions for limit check
    const allSessionsResult = await dynamo.send(new QueryCommand({
      TableName: process.env.SESSIONS_TABLE,
      IndexName: 'item-index',
      KeyConditionExpression: 'itemId = :iid',
      ExpressionAttributeValues: { ':iid': { S: itemId } },
      Select: 'COUNT',
    }))

    const existingCount = allSessionsResult.Count ?? 0

    // Fetch tenant record for feature flags
    let maxSessions = DEFAULT_MAX_SESSIONS_FREE
    if (process.env.TENANTS_TABLE) {
      try {
        const tenantRecord = await dynamo.send(new GetItemCommand({
          TableName: process.env.TENANTS_TABLE,
          Key: { tenantId: { S: tenantId } },
        }))
        if (tenantRecord.Item) {
          const tier = tenantRecord.Item.tier?.S ?? 'free'
          const featuresMap = tenantRecord.Item.features?.M ?? {}
          if (featuresMap.maxSessionsPerItem?.N !== undefined) {
            maxSessions = Number(featuresMap.maxSessionsPerItem.N)
          } else {
            maxSessions = tier === 'paid' ? DEFAULT_MAX_SESSIONS_PAID : DEFAULT_MAX_SESSIONS_FREE
          }
        }
      } catch (err) {
        log('warn', 'CreateSelfSession: could not fetch tenant record, using defaults', { requestId, tenantId })
      }
    }

    if (existingCount >= maxSessions) {
      log('warn', 'CreateSelfSession: session limit exceeded', { requestId, tenantId, itemId, existingCount, maxSessions })
      return errorResponse(403, 'Session limit reached for this item.', {}, origin)
    }

    // Create the self-review session
    const sessionId = randomUUID()
    const now = new Date().toISOString()

    await dynamo.send(new PutItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Item: {
        tenantId: { S: tenantId },
        sessionId: { S: sessionId },
        itemId: { S: itemId },
        // Tenant is both owner and reviewer — no external email
        reviewerEmail: { S: '' },
        isSelfReview: { BOOL: true },
        status: { S: 'not_started' },
        timeLimitMinutes: { N: String(timeLimitMinutes) },
        createdAt: { S: now },
        updatedAt: { S: now },
        ...(closeDate ? { expiresAt: { S: closeDate } } : {}),
      },
    }))

    log('info', 'CreateSelfSession: session created', { requestId, tenantId, itemId, sessionId })

    // Update item sessionCount (and activate if draft)
    const isFirstSession = itemStatus === 'draft'
    if (isFirstSession) {
      await dynamo.send(new UpdateItemCommand({
        TableName: process.env.ITEMS_TABLE,
        Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
        UpdateExpression: 'SET #status = :active, lockedAt = :now, updatedAt = :now ADD sessionCount :n',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':active': { S: 'active' },
          ':now': { S: now },
          ':n': { N: '1' },
        },
      }))
    } else {
      await dynamo.send(new UpdateItemCommand({
        TableName: process.env.ITEMS_TABLE,
        Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
        UpdateExpression: 'SET updatedAt = :now ADD sessionCount :n',
        ExpressionAttributeValues: {
          ':now': { S: now },
          ':n': { N: '1' },
        },
      }))
    }

    // Generate session token directly — no email validation needed
    // Format: {tenantId}:{sessionId} — matches sessionAuth authorizer format
    const sessionToken = `${tenantId}:${sessionId}`
    const appUrl = process.env.APP_URL
    const sessionUrl = `${appUrl}/s/${sessionId}?token=${encodeURIComponent(sessionToken)}`

    log('info', 'CreateSelfSession: completed', { requestId, tenantId, itemId, sessionId })

    return createResponse(201, {
      data: {
        sessionId,
        sessionUrl,
      },
    }, {}, origin)
  } catch (err) {
    log('error', 'CreateSelfSession: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to create self-review session', {}, origin)
  }
}
