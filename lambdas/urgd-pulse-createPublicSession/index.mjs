// ur/gd pulse — Create Public Session Lambda
// POST /api/manage/items/{itemId}/public-session
// Creates a single walk-in / QR session with no email requirement

import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createResponse, errorResponse, log, requireEnv, unmarshalFeatures } from './shared/utils.mjs'
import { resolveFeature } from './shared/features.mjs'
import { checkAndIncrement } from './shared/counters.mjs'
import { randomBytes, randomUUID } from 'crypto'
import QRCode from 'qrcode'

// Fail-fast env var validation
requireEnv(['SESSIONS_TABLE', 'ITEMS_TABLE', 'DATA_BUCKET', 'CORS_ALLOWED_ORIGINS', 'APP_URL'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })

/**
 * Generates a unique 8-character alphanumeric pulse code (no ambiguous chars).
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
    log('warn', 'CreatePublicSession: missing tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!itemId) {
    return errorResponse(400, 'itemId is required', {}, origin)
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return errorResponse(400, 'Invalid request body', {}, origin)
  }

  const { closeDate, sessionName } = body

  if (!closeDate || typeof closeDate !== 'string') {
    return errorResponse(400, 'closeDate is required', {}, origin)
  }

  const closeDateMs = Date.parse(closeDate)
  if (isNaN(closeDateMs) || closeDateMs <= Date.now()) {
    return errorResponse(400, 'closeDate must be a valid future date', {}, origin)
  }

  try {
    // Verify item ownership and status
    const itemResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
      },
    }))

    if (!itemResult.Item) {
      log('warn', 'CreatePublicSession: item not found', { requestId, tenantId, itemId })
      return errorResponse(404, 'Item not found', {}, origin)
    }

    const itemStatus = itemResult.Item.status?.S
    if (itemStatus !== 'draft' && itemStatus !== 'active') {
      return errorResponse(409, 'Item is not accepting new sessions', {}, origin)
    }

    // Fetch tenant + SYSTEM records for feature flag resolution
    let tenantRecord = { tier: 'free', features: {}, serviceFlags: {} }
    let systemRecord = null
    if (process.env.TENANTS_TABLE) {
      try {
        const [tenantResult, systemResult] = await Promise.all([
          dynamo.send(new GetItemCommand({
            TableName: process.env.TENANTS_TABLE,
            Key: { tenantId: { S: tenantId } },
          })),
          dynamo.send(new GetItemCommand({
            TableName: process.env.TENANTS_TABLE,
            Key: { tenantId: { S: 'SYSTEM' } },
          })),
        ])
        if (tenantResult.Item) {
          tenantRecord = {
            tier: tenantResult.Item.tier?.S ?? 'free',
            features: unmarshalFeatures(tenantResult.Item.features?.M),
            serviceFlags: unmarshalFeatures(tenantResult.Item.serviceFlags?.M),
            usageCounters: unmarshalFeatures(tenantResult.Item.usageCounters?.M),
            orgId: tenantResult.Item.orgId?.S ?? null,
          }
        }
        if (systemResult.Item) {
          systemRecord = { serviceFlags: unmarshalFeatures(systemResult.Item.serviceFlags?.M) }
        }
      } catch (err) {
        log('warn', 'CreatePublicSession: failed to fetch tenant/SYSTEM records', { requestId, tenantId, errorName: err.name })
      }
    }

    // Check publicSessions feature flag
    const publicSessionsResult = resolveFeature(tenantRecord, 'publicSessions', systemRecord)
    if (!publicSessionsResult.allowed) {
      return errorResponse(
        publicSessionsResult.reason === 'maintenance' ? 503 : 403,
        publicSessionsResult.reason === 'maintenance' ? 'Feature under maintenance' : 'Feature not available on your plan',
        {}, origin
      )
    }

    // Check maxSessionsPerItem limit
    const maxSessionsResult = resolveFeature(tenantRecord, 'maxSessionsPerItem', systemRecord)

    // Check sessionTimeLimitMinutes
    const timeLimitResult = resolveFeature(tenantRecord, 'sessionTimeLimitMinutes', systemRecord)

    // Read recommended time limit from item — snap to bracket midpoints
    const BRACKETS = [12, 17, 25, 37]
    const rawItemMinutes = itemResult.Item.recommendedTimeLimitMinutes?.N
      ? parseInt(itemResult.Item.recommendedTimeLimitMinutes.N, 10)
      : null
    const sessionTimeLimitMinutes = rawItemMinutes
      ? BRACKETS.reduce((best, b) => Math.abs(b - rawItemMinutes) < Math.abs(best - rawItemMinutes) ? b : best, BRACKETS[0])
      : 17

    // Cap time limit by tier limit
    const maxTimeLimit = timeLimitResult.limit ?? 120
    const cappedTimeLimitMinutes = Math.min(sessionTimeLimitMinutes, maxTimeLimit)

    // Check session count against maxSessionsPerItem
    const maxSessions = maxSessionsResult.limit ?? 5

    // Query existing session count excluding self-review sessions
    const existingSessionsResult = await dynamo.send(new QueryCommand({
      TableName: process.env.SESSIONS_TABLE,
      IndexName: 'item-index',
      KeyConditionExpression: 'itemId = :iid',
      FilterExpression: 'attribute_not_exists(sessionType) OR sessionType <> :selfType',
      ExpressionAttributeValues: {
        ':iid': { S: itemId },
        ':selfType': { S: 'self' },
      },
      Select: 'COUNT',
    }))

    const existingCount = existingSessionsResult.Count ?? 0
    if (existingCount >= maxSessions) {
      log('warn', 'CreatePublicSession: session limit reached', { requestId, tenantId, itemId, existingCount, maxSessions })
      return errorResponse(403, 'This item has reached its feedback limit.', { error: 'session_limit_reached' }, origin)
    }

    // Monthly counter enforcement — monthlyPublicSessionsTotal
    const publicCounterResult = await checkAndIncrement({
      tenantId,
      counterName: 'monthlyPublicSessionsTotal',
      tenantRecord,
      systemRecord,
      orgId: tenantRecord.orgId ?? null,
    })
    if (!publicCounterResult.allowed) {
      log('warn', 'CreatePublicSession: monthly public session limit reached', { requestId, tenantId, reason: publicCounterResult.reason })
      return errorResponse(403, 'Monthly public session limit reached', {
        reason: publicCounterResult.reason,
        counter: publicCounterResult.counter,
        resetDate: publicCounterResult.resetDate,
      }, origin)
    }

    // Monthly counter enforcement — monthlySessionsTotal
    const sessionCounterResult = await checkAndIncrement({
      tenantId,
      counterName: 'monthlySessionsTotal',
      tenantRecord,
      systemRecord,
      orgId: tenantRecord.orgId ?? null,
    })
    if (!sessionCounterResult.allowed) {
      log('warn', 'CreatePublicSession: monthly session limit reached', { requestId, tenantId, reason: sessionCounterResult.reason })
      return errorResponse(403, 'Monthly session limit reached', {
        reason: sessionCounterResult.reason,
        counter: sessionCounterResult.counter,
        resetDate: sessionCounterResult.resetDate,
      }, origin)
    }

    const sessionId = randomUUID()
    const pulseCode = generatePulseCode()
    const sessionLink = `${process.env.APP_URL}/s/${sessionId}?public=1`
    const now = new Date().toISOString()

    // Store session record — reviewerEmail is null, isPublic is true
    const sessionItem = {
      tenantId: { S: tenantId },
      sessionId: { S: sessionId },
      itemId: { S: itemId },
      pulseCode: { S: pulseCode },
      status: { S: 'not_started' },
      isPublic: { BOOL: true },
      timeLimitMinutes: { N: String(cappedTimeLimitMinutes) },
      expiresAt: { S: closeDate },
      createdAt: { S: now },
    }
    if (sessionName && typeof sessionName === 'string') {
      sessionItem.sessionName = { S: sessionName.trim().slice(0, 100) }
    }
    // 5.5: Frozen snapshot
    if (itemResult.Item.sectionMap?.M) {
      sessionItem.frozenSnapshot = {
        M: {
          sectionMap: itemResult.Item.sectionMap,
          feedbackSections: itemResult.Item.feedbackSections || { L: [] },
          sectionDepthPreferences: itemResult.Item.sectionDepthPreferences || { M: {} },
        },
      }
      sessionItem.sectionCoverage = buildInitialSectionCoverage(itemResult.Item)
    } else {
      // No sectionMap — set totalSections explicitly (image items = 1, fallback = 5)
      sessionItem.totalSections = { N: String(itemResult.Item.totalSections?.N || '5') }
    }
    await dynamo.send(new PutItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Item: sessionItem,
    }))

    log('info', 'CreatePublicSession: session created', { requestId, tenantId, itemId, sessionId })

    // Activate item if still draft + increment sessionCount
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
          log('info', 'CreatePublicSession: item already activated concurrently', { requestId, tenantId, itemId })
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

    // Generate QR code PNG and store in S3
    const qrKey = `pulse/${tenantId}/items/${itemId}/qr/public-${sessionId}.png`
    let qrCodeUrl = null

    try {
      const qrBuffer = await QRCode.toBuffer(sessionLink, { type: 'png', width: 300 })
      await s3.send(new PutObjectCommand({
        Bucket: process.env.DATA_BUCKET,
        Key: qrKey,
        Body: qrBuffer,
        ContentType: 'image/png',
      }))

      // Generate presigned GET URL (1-hour TTL)
      qrCodeUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: process.env.DATA_BUCKET, Key: qrKey }),
        { expiresIn: 3600 }
      )

      log('info', 'CreatePublicSession: QR code stored', { requestId, tenantId, itemId, sessionId })
    } catch (qrErr) {
      log('error', 'CreatePublicSession: QR code generation/upload failed', {
        requestId, tenantId, itemId, sessionId, errorName: qrErr.name,
      })
      // Non-fatal — return session without QR URL
    }

    return createResponse(201, {
      sessionId,
      pulseCode,
      sessionLink,
      qrCodeUrl,
    }, {}, origin)
  } catch (err) {
    log('error', 'CreatePublicSession: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to create public session', {}, origin)
  }
}
