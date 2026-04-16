// ur/gd pulse — Validate Session Lambda
// POST /api/session/validate (public — no auth)
// Validates a reviewer's session via pulseCode or sessionId + email match

import { DynamoDBClient, GetItemCommand, QueryCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { primeCacheAsync } from './shared/primeCacheAsync.mjs'
import { randomUUID } from 'crypto'

// Fail-fast env var validation
requireEnv(['SESSIONS_TABLE', 'ITEMS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return errorResponse(400, 'Invalid request body', {}, origin)
  }

  const { sessionId, pulseCode, email, name } = body

  // At least one of sessionId or pulseCode must be provided
  if (!sessionId && !pulseCode) {
    return errorResponse(400, 'sessionId or pulseCode is required', {}, origin)
  }

  try {
    let sessionRecord = null

    if (pulseCode) {
      // Look up session via pulseCode-index GSI
      const result = await dynamo.send(new QueryCommand({
        TableName: process.env.SESSIONS_TABLE,
        IndexName: 'pulseCode-index',
        KeyConditionExpression: 'pulseCode = :pc',
        ExpressionAttributeValues: { ':pc': { S: pulseCode } },
        Limit: 1,
      }))

      if (result.Items && result.Items.length > 0) {
        sessionRecord = result.Items[0]
      }
    } else {
      // Look up session via sessionId-index GSI
      const result = await dynamo.send(new QueryCommand({
        TableName: process.env.SESSIONS_TABLE,
        IndexName: 'sessionId-index',
        KeyConditionExpression: 'sessionId = :sid',
        ExpressionAttributeValues: { ':sid': { S: sessionId } },
        Limit: 1,
      }))

      if (result.Items && result.Items.length > 0) {
        sessionRecord = result.Items[0]
      }
    }

    if (!sessionRecord) {
      log('info', 'ValidateSession: session not found', { requestId })
      return errorResponse(404, 'Session not found', {}, origin)
    }

    const foundSessionId = sessionRecord.sessionId?.S
    const tenantId = sessionRecord.tenantId?.S
    const reviewerEmail = sessionRecord.reviewerEmail?.S
    const status = sessionRecord.status?.S
    const expiresAt = sessionRecord.expiresAt?.S
    const itemId = sessionRecord.itemId?.S

    log('info', 'ValidateSession: session found', { requestId, sessionId: foundSessionId, tenantId })

    const isPublic = sessionRecord.isPublic?.BOOL === true
    const isSelfReview = sessionRecord.isSelfReview?.BOOL === true
    const isPreview = sessionRecord.preview?.BOOL === true

    // Check expiry — expiresAt stored as ISO string (closeDate format from inviteReviewer)
    const isExpiredByStatus = status === 'expired'
    const isExpiredByDate = expiresAt && new Date(expiresAt) < new Date()

    if (status === 'cancelled') {
      log('info', 'ValidateSession: session cancelled', { requestId, sessionId: foundSessionId, tenantId })
      return errorResponse(410, 'This invitation has been cancelled', {}, origin)
    }

    // Discarded session recovery — reset to not_started so reviewer gets a clean restart
    if (status === 'discarded') {
      try {
        await dynamo.send(new UpdateItemCommand({
          TableName: process.env.SESSIONS_TABLE,
          Key: { tenantId: { S: tenantId }, sessionId: { S: foundSessionId } },
          UpdateExpression: 'SET #status = :status REMOVE discardedAt',
          ConditionExpression: '#status = :discarded',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': { S: 'not_started' }, ':discarded': { S: 'discarded' } },
        }))
        log('info', 'ValidateSession: discarded session recovered', { requestId, sessionId: foundSessionId, tenantId })
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') {
          log('warn', 'ValidateSession: discarded session status changed concurrently', { requestId, sessionId: foundSessionId, tenantId })
          return errorResponse(409, 'Session state changed — please try again', {}, origin)
        }
        throw err
      }
      // Continue with normal validation flow — session is now not_started
    }

    if (isExpiredByStatus || isExpiredByDate) {
      log('info', 'ValidateSession: session expired', { requestId, sessionId: foundSessionId, tenantId })
      return errorResponse(410, 'This session has expired', {}, origin)
    }

    // Public sessions skip email validation — any visitor proceeds directly to confidentiality
    // Self-review sessions skip email match check — Cognito JWT is the identity proof
    // Preview sessions skip email match check — short-lived token, no reviewer email set
    if (!isPublic && !isSelfReview && !isPreview) {
      if (!email || typeof email !== 'string') {
        return errorResponse(400, 'email is required', {}, origin)
      }
      if (!reviewerEmail || reviewerEmail.toLowerCase() !== email.toLowerCase().trim()) {
        log('warn', 'ValidateSession: email mismatch', { requestId, sessionId: foundSessionId, tenantId })
        return errorResponse(403, 'Email address does not match our records', {}, origin)
      }
    }

    // Load item context — also enforces closed-item gate
    let itemContext = {}
    let itemRecord = null
    if (itemId && tenantId) {
      try {
        const itemResult = await dynamo.send(new GetItemCommand({
          TableName: process.env.ITEMS_TABLE,
          Key: {
            tenantId: { S: tenantId },
            itemId: { S: itemId },
          },
        }))

        if (itemResult.Item) {
          itemRecord = itemResult.Item
          const itemStatus = itemResult.Item.status?.S
          // Block new session entry if item is closed — in_progress sessions can finish naturally
          if (itemStatus === 'closed' && status === 'not_started') {
            log('info', 'ValidateSession: item is closed, rejecting not_started session', { requestId, sessionId: foundSessionId, tenantId, itemId })
            return errorResponse(410, 'This item is no longer accepting feedback', {}, origin)
          }
          itemContext = {
            itemId,
            itemName: itemResult.Item.itemName?.S ?? '',
            description: itemResult.Item.description?.S ?? '',
          }
        }
      } catch (itemErr) {
        log('warn', 'ValidateSession: failed to load item context', { requestId, sessionId: foundSessionId, tenantId, errorName: itemErr.name })
      }
    }

    // Public sessions: fork a new child session per visitor so each person gets their own
    let activeSessionId = foundSessionId
    if (isPublic) {
      const childSessionId = randomUUID()
      const childItem = {
        tenantId: { S: tenantId },
        sessionId: { S: childSessionId },
        parentSessionId: { S: foundSessionId },
        itemId: { S: itemId || '' },
        isPublic: { BOOL: true },
        status: { S: 'not_started' },
        totalSections: sessionRecord.totalSections ?? { N: '5' },
        timeLimitMinutes: sessionRecord.timeLimitMinutes ?? { N: '30' },
        expiresAt: sessionRecord.expiresAt ?? { S: '' },
        createdAt: { S: new Date().toISOString() },
        updatedAt: { S: new Date().toISOString() },
      }
      if (name) childItem.reviewerName = { S: name.trim() }
      await dynamo.send(new PutItemCommand({
        TableName: process.env.SESSIONS_TABLE,
        Item: childItem,
      }))
      activeSessionId = childSessionId
      log('info', 'ValidateSession: forked public child session', { requestId, parentSessionId: foundSessionId, childSessionId, tenantId })
    }

    // Generate session token: {tenantId}:{sessionId} — matches sessionAuth authorizer format
    const sessionToken = `${tenantId}:${activeSessionId}`

    log('info', 'ValidateSession: success', { requestId, sessionId: activeSessionId, tenantId })

    const resp = createResponse(200, {
      sessionToken,
      sessionId: activeSessionId,
      tenantId,
      item: itemContext,
      isSelfReview: isSelfReview || undefined,
      isPreview: isPreview || undefined,
      ...(isPublic && name ? { reviewerName: name.trim() } : {}),
    }, {}, origin)

    // Fire-and-forget priming (async, after response)
    if (itemRecord && activeSessionId) {
      primeCacheAsync({
        itemName: itemRecord.itemName?.S || '',
        itemDescription: itemRecord.description?.S || '',
        itemType: itemRecord.itemType?.S || '',
        documentKey: itemRecord.documentKey?.S || '',
        pageCount: parseInt(itemRecord.pageCount?.N || '0', 10),
        tenantId,
        itemId: itemRecord.itemId?.S || itemId,
        sessionId: activeSessionId,
        requestId,
        frozenSnapshot: null,
        timeLimitMinutes: parseInt(sessionRecord.timeLimitMinutes?.N || '30', 10),
        isSelfReview: isSelfReview || false,
        coverageMap: null,
        dataBucket: process.env.DATA_BUCKET,
        bedrockModelId: process.env.BEDROCK_MODEL_ID,
      })
    }

    return resp
  } catch (err) {
    log('error', 'ValidateSession: unexpected error', { requestId, errorName: err.name })
    return errorResponse(500, 'Failed to validate session', {}, origin)
  }
}
