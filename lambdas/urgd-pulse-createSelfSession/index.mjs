// ur/gd pulse — Create Self-Review Session Lambda
// POST /api/manage/items/{itemId}/self-review
// Creates a session where the tenant is both the item owner and the reviewer.
// No email, no pulse code, no SES — the Cognito JWT is the identity proof.
// Sets isSelfReview: true on the session record.
// Generates a session token directly and returns { sessionId, sessionUrl }.

import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { createResponse, errorResponse, log, requireEnv, unmarshalFeatures } from './shared/utils.mjs'
import { resolveFeature } from './shared/features.mjs'
import { checkAndIncrement } from './shared/counters.mjs'
import { randomUUID } from 'crypto'

requireEnv(['SESSIONS_TABLE', 'ITEMS_TABLE', 'CORS_ALLOWED_ORIGINS', 'APP_URL'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' })

/**
 * Build initial sectionCoverage map from item's feedbackSections (5.5).
 */
function buildInitialSectionCoverage(item) {
  const feedbackSections = item.feedbackSections?.L
  if (!feedbackSections || feedbackSections.length === 0) return { M: {} }
  const m = {}
  for (const s of feedbackSections) {
    const sId = s.S || s
    if (sId) {
      m[sId] = { M: { touched: { BOOL: false }, depth: { NULL: true } } }
    }
  }
  return { M: m }
}

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

    // cappedTimeLimitMinutes is computed after feature flag resolution below

    // Check for an existing self-review session — if found, return 409 with existingSessionId
    // so the frontend can offer a "start over" flow
    const existingSessionsResult = await dynamo.send(new QueryCommand({
      TableName: process.env.SESSIONS_TABLE,
      IndexName: 'item-index',
      KeyConditionExpression: 'itemId = :iid',
      FilterExpression: 'isSelfReview = :t AND #st <> :cancelled AND #st <> :discarded',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':iid': { S: itemId },
        ':t': { BOOL: true },
        ':cancelled': { S: 'cancelled' },
        ':discarded': { S: 'discarded' },
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

    // Fetch tenant + SYSTEM records for feature flag resolution
    let tenantRecord = { tier: 'free', features: {}, serviceFlags: {} }
    let systemRecord = null
    if (process.env.TENANTS_TABLE) {
      try {
        const [tenantFetch, systemFetch] = await Promise.all([
          dynamo.send(new GetItemCommand({
            TableName: process.env.TENANTS_TABLE,
            Key: { tenantId: { S: tenantId } },
          })),
          dynamo.send(new GetItemCommand({
            TableName: process.env.TENANTS_TABLE,
            Key: { tenantId: { S: 'SYSTEM' } },
          })),
        ])
        if (tenantFetch.Item) {
          tenantRecord = {
            tier: tenantFetch.Item.tier?.S ?? 'free',
            features: unmarshalFeatures(tenantFetch.Item.features?.M),
            serviceFlags: unmarshalFeatures(tenantFetch.Item.serviceFlags?.M),
            usageCounters: unmarshalFeatures(tenantFetch.Item.usageCounters?.M),
            orgId: tenantFetch.Item.orgId?.S ?? null,
          }
        }
        if (systemFetch.Item) {
          systemRecord = { serviceFlags: unmarshalFeatures(systemFetch.Item.serviceFlags?.M) }
        }
      } catch (err) {
        log('warn', 'CreateSelfSession: failed to fetch tenant/SYSTEM records', { requestId, tenantId, errorName: err.name })
      }
    }

    // Check selfReview feature flag
    const selfReviewResult = resolveFeature(tenantRecord, 'selfReview', systemRecord)
    if (!selfReviewResult.allowed) {
      return errorResponse(
        selfReviewResult.reason === 'maintenance' ? 503 : 403,
        selfReviewResult.reason === 'maintenance' ? 'Feature under maintenance' : 'Feature not available on your plan',
        {}, origin
      )
    }

    // Check maxSessionsPerItem limit
    const maxSessionsResult = resolveFeature(tenantRecord, 'maxSessionsPerItem', systemRecord)
    const maxSessions = maxSessionsResult.limit ?? 5

    // Check sessionTimeLimitMinutes
    const timeLimitResult = resolveFeature(tenantRecord, 'sessionTimeLimitMinutes', systemRecord)
    const maxTimeLimit = timeLimitResult.limit ?? 120

    // Cap time limit by tier limit (must be after feature flag resolution)
    const cappedTimeLimitMinutes = Math.min(timeLimitMinutes, maxTimeLimit)

    if (existingCount >= maxSessions) {
      log('warn', 'CreateSelfSession: session limit exceeded', { requestId, tenantId, itemId, existingCount, maxSessions })
      return errorResponse(403, 'Session limit reached for this item.', {}, origin)
    }

    // Monthly counter enforcement — monthlySessionsTotal
    const counterResult = await checkAndIncrement({
      tenantId,
      counterName: 'monthlySessionsTotal',
      tenantRecord,
      systemRecord,
      orgId: tenantRecord.orgId ?? null,
    })
    if (!counterResult.allowed) {
      log('warn', 'CreateSelfSession: monthly session limit reached', { requestId, tenantId, reason: counterResult.reason })
      return errorResponse(403, 'Monthly session limit reached', {
        reason: counterResult.reason,
        counter: counterResult.counter,
        resetDate: counterResult.resetDate,
      }, origin)
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
        timeLimitMinutes: { N: String(cappedTimeLimitMinutes) },
        createdAt: { S: now },
        updatedAt: { S: now },
        ...(closeDate ? { expiresAt: { S: closeDate } } : {}),
        // 5.5: Frozen snapshot
        ...(itemResult.Item.sectionMap?.M ? {
          frozenSnapshot: {
            M: {
              sectionMap: itemResult.Item.sectionMap,
              feedbackSections: itemResult.Item.feedbackSections || { L: [] },
              sectionDepthPreferences: itemResult.Item.sectionDepthPreferences || { M: {} },
            },
          },
          sectionCoverage: buildInitialSectionCoverage(itemResult.Item),
        } : {
          // No sectionMap — set totalSections explicitly (image items = 1, fallback = 5)
          totalSections: { N: String(itemResult.Item.totalSections?.N || '5') },
        }),
      },
    }))

    log('info', 'CreateSelfSession: session created', { requestId, tenantId, itemId, sessionId })

    // Update item sessionCount (and activate if draft)
    const isFirstSession = itemStatus === 'draft'
    if (isFirstSession) {
      try {
        await dynamo.send(new UpdateItemCommand({
          TableName: process.env.ITEMS_TABLE,
          Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
          UpdateExpression: 'SET #status = :active, lockedAt = :now, updatedAt = :now ADD sessionCount :n',
          ConditionExpression: '#status = :draft',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':active': { S: 'active' },
            ':draft': { S: 'draft' },
            ':now': { S: now },
            ':n': { N: '1' },
          },
        }))
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') {
          // Item was already activated by a concurrent request — safe to continue
          log('info', 'CreateSelfSession: item already activated concurrently', { requestId, tenantId, itemId })
        } else {
          throw err
        }
      }
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

    const resp = createResponse(201, {
      data: {
        sessionId,
        sessionUrl,
      },
    }, {}, origin)

    // Async Lambda invocation — guaranteed to complete (own execution lifecycle)
    if (itemResult.Item && process.env.PRIME_CACHE_FUNCTION_NAME) {
      const item = itemResult.Item
      lambda.send(new InvokeCommand({
        FunctionName: process.env.PRIME_CACHE_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: JSON.stringify({
          itemName: item.itemName?.S || '',
          itemDescription: item.description?.S || '',
          itemType: item.itemType?.S || '',
          documentKey: item.documentKey?.S || '',
          pageCount: parseInt(item.pageCount?.N || '0', 10),
          tenantId,
          itemId,
          sessionId,
          requestId,
          frozenSnapshot: item.sectionMap?.M ? {
            feedbackSections: (item.feedbackSections?.L || []).map(s => s.S || s),
          } : null,
          timeLimitMinutes: cappedTimeLimitMinutes,
          isSelfReview: true,
          coverageMap: null,
        }),
      })).catch(err => {
        log('warn', 'Failed to invoke prime cache worker', { requestId, errorName: err.name })
      })
    }

    return resp
  } catch (err) {
    log('error', 'CreateSelfSession: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to create self-review session', {}, origin)
  }
}
