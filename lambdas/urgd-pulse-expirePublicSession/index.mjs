// ur/gd pulse — Expire Public Session Lambda
// PUT /api/manage/items/{itemId}/sessions/{sessionId}/expire
// Immediately expires an in_progress or not_started public session by setting expiresAt to now.
// Active reviewers can finish naturally; no new walk-ins are accepted.

import { DynamoDBClient, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['SESSIONS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId
  const sessionId = event?.pathParameters?.sessionId

  if (!tenantId) {
    log('warn', 'ExpirePublicSession: missing tenantId', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!itemId || !sessionId) {
    return errorResponse(400, 'itemId and sessionId are required', {}, origin)
  }

  try {
    // Look up session via sessionId-index GSI
    const result = await dynamo.send(new QueryCommand({
      TableName: process.env.SESSIONS_TABLE,
      IndexName: 'sessionId-index',
      KeyConditionExpression: 'sessionId = :sid',
      ExpressionAttributeValues: { ':sid': { S: sessionId } },
      Limit: 1,
    }))

    const sessionRecord = result.Items?.[0]

    if (!sessionRecord) {
      return errorResponse(404, 'Session not found', {}, origin)
    }

    // Verify ownership, item match, and that it's a public session
    if (sessionRecord.tenantId?.S !== tenantId || sessionRecord.itemId?.S !== itemId) {
      return errorResponse(404, 'Session not found', {}, origin)
    }

    if (sessionRecord.isPublic?.BOOL !== true) {
      return errorResponse(400, 'Only public sessions can be expired via this endpoint', {}, origin)
    }

    const currentStatus = sessionRecord.status?.S
    if (currentStatus !== 'not_started' && currentStatus !== 'in_progress') {
      return errorResponse(409, `Session is already ${currentStatus}`, {}, origin)
    }

    const now = new Date().toISOString()

    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        sessionId: { S: sessionId },
      },
      UpdateExpression: 'SET expiresAt = :now, #st = :expired',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':now': { S: now },
        ':expired': { S: 'expired' },
      },
    }))

    log('info', 'ExpirePublicSession: session expired', { requestId, tenantId, itemId, sessionId })

    return createResponse(200, { sessionId, status: 'expired' }, {}, origin)
  } catch (err) {
    log('error', 'ExpirePublicSession: unexpected error', { requestId, tenantId, itemId, sessionId, errorName: err.name })
    return errorResponse(500, 'Failed to expire session', {}, origin)
  }
}
