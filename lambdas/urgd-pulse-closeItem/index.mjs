// ur/gd pulse — Close Item Lambda
// PUT /api/manage/items/{itemId}/close
// Sets item status → closed, batch-expires all not_started sessions for the item.
// in_progress sessions are left untouched — reviewers can finish naturally.

import { DynamoDBClient, GetItemCommand, UpdateItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { deleteCloseSchedule } from './shared/scheduleClose.mjs'

requireEnv(['ITEMS_TABLE', 'SESSIONS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const { itemId } = event?.pathParameters ?? {}

  if (!tenantId) return errorResponse(401, 'Unauthorized', {}, origin)
  if (!itemId) return errorResponse(400, 'itemId is required', {}, origin)

  try {
    // Verify item exists and belongs to this tenant
    const itemResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
    }))

    if (!itemResult.Item) {
      return errorResponse(404, 'Item not found', {}, origin)
    }

    const currentStatus = itemResult.Item.status?.S
    if (currentStatus === 'closed') {
      return errorResponse(409, 'Item is already closed', {}, origin)
    }

    const now = new Date().toISOString()

    // Set item status → closed
    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
      UpdateExpression: 'SET #status = :closed, closedAt = :now, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':closed': { S: 'closed' },
        ':now': { S: now },
      },
    }))

    // Batch-expire all not_started sessions for this item
    // in_progress sessions are left to finish naturally; the pulse check re-run banner
    // handles including them once they complete.
    let expiredCount = 0
    let lastKey = undefined

    do {
      const sessionsResult = await dynamo.send(new QueryCommand({
        TableName: process.env.SESSIONS_TABLE,
        IndexName: 'item-index',
        KeyConditionExpression: 'itemId = :iid',
        FilterExpression: '#status = :not_started AND tenantId = :tid',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':iid': { S: itemId },
          ':tid': { S: tenantId },
          ':not_started': { S: 'not_started' },
        },
        ExclusiveStartKey: lastKey,
      }))

      const sessions = sessionsResult.Items ?? []

      for (const session of sessions) {
        const sid = session.sessionId?.S
        if (!sid) continue
        await dynamo.send(new UpdateItemCommand({
          TableName: process.env.SESSIONS_TABLE,
          Key: { tenantId: { S: tenantId }, sessionId: { S: sid } },
          UpdateExpression: 'SET #status = :expired, expiresAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':expired': { S: 'expired' },
            ':now': { S: now },
          },
        }))
        expiredCount++
      }

      lastKey = sessionsResult.LastEvaluatedKey
    } while (lastKey)

    // Remove the EventBridge close schedule since item was manually closed (Slice 3 — R1.4)
    try {
      await deleteCloseSchedule(itemId)
      log('info', 'CloseItem: close schedule deleted', { requestId, tenantId, itemId })
    } catch (err) {
      log('warn', 'CloseItem: failed to delete close schedule (non-fatal)', { requestId, tenantId, itemId, errorName: err.name })
    }

    log('info', 'CloseItem: item closed', { requestId, tenantId, itemId, expiredCount })

    return createResponse(200, { itemId, status: 'closed', expiredSessions: expiredCount }, {}, origin)
  } catch (err) {
    log('error', 'CloseItem: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to close item', {}, origin)
  }
}
