// ur/gd pulse — Create Public Session Lambda
// POST /api/manage/items/{itemId}/public-session
// Creates a single walk-in / QR session with no email requirement

import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
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

    // Read recommended time limit from item — snap to bracket midpoints
    const BRACKETS = [12, 17, 25, 37]
    const rawItemMinutes = itemResult.Item.recommendedTimeLimitMinutes?.N
      ? parseInt(itemResult.Item.recommendedTimeLimitMinutes.N, 10)
      : null
    const sessionTimeLimitMinutes = rawItemMinutes
      ? BRACKETS.reduce((best, b) => Math.abs(b - rawItemMinutes) < Math.abs(best - rawItemMinutes) ? b : best, BRACKETS[0])
      : 17

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
      timeLimitMinutes: { N: String(sessionTimeLimitMinutes) },
      expiresAt: { S: closeDate },
      createdAt: { S: now },
    }
    if (sessionName && typeof sessionName === 'string') {
      sessionItem.sessionName = { S: sessionName.trim().slice(0, 100) }
    }
    await dynamo.send(new PutItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Item: sessionItem,
    }))

    log('info', 'CreatePublicSession: session created', { requestId, tenantId, itemId, sessionId })

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
