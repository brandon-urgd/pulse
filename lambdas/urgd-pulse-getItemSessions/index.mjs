// ur/gd pulse — Get Item Sessions Lambda
// GET /api/manage/items/{itemId}/sessions → returns sessions for an item, sorted by createdAt asc

import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from '../shared/utils.mjs'

// Fail-fast env var validation
requireEnv(['SESSIONS_TABLE', 'ITEMS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) {
    log('warn', 'GetItemSessions: missing tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!itemId) {
    return errorResponse(400, 'Missing itemId', {}, origin)
  }

  log('info', 'GetItemSessions: fetching sessions', { requestId, tenantId, itemId })

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
      log('warn', 'GetItemSessions: item not found', { requestId, tenantId, itemId })
      return errorResponse(404, 'Item not found', {}, origin)
    }

    // Belt-and-suspenders: verify tenant ownership
    if (itemResult.Item.tenantId?.S !== tenantId) {
      log('warn', 'GetItemSessions: tenant mismatch', { requestId, tenantId, itemId })
      return errorResponse(404, 'Item not found', {}, origin)
    }

    // Query sessions via item-index GSI
    const sessionsResult = await dynamo.send(new QueryCommand({
      TableName: process.env.SESSIONS_TABLE,
      IndexName: 'item-index',
      KeyConditionExpression: 'itemId = :iid',
      ExpressionAttributeValues: { ':iid': { S: itemId } },
    }))

    const sessions = (sessionsResult.Items ?? [])
      .filter((item) => item.status?.S !== 'cancelled')
      .map((item) => {
        const session = {
          sessionId: item.sessionId?.S ?? '',
          pulseCode: item.pulseCode?.S ?? '',
          reviewerEmail: item.reviewerEmail?.S ?? '',
          status: item.status?.S ?? 'not_started',
          createdAt: item.createdAt?.S ?? '',
          expiresAt: item.expiresAt?.S ?? '',
        }
        if (item.startedAt?.S) session.startedAt = item.startedAt.S
        if (item.completedAt?.S) session.completedAt = item.completedAt.S
        return session
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    log('info', 'GetItemSessions: completed', { requestId, tenantId, itemId, count: sessions.length })

    return createResponse(200, { data: sessions }, {}, origin)
  } catch (err) {
    log('error', 'GetItemSessions: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to retrieve sessions', {}, origin)
  }
}
