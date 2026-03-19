// ur/gd pulse — Cancel Session Lambda
// DELETE /api/manage/items/{itemId}/sessions/{sessionId} → cancels a not_started session
// Sets status to "cancelled" (soft delete) so the pulse code returns a clear message if used

import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['SESSIONS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const { itemId, sessionId } = event?.pathParameters ?? {}

  if (!tenantId) return errorResponse(401, 'Unauthorized', {}, origin)
  if (!itemId || !sessionId) return errorResponse(400, 'itemId and sessionId are required', {}, origin)

  try {
    // Fetch session to verify ownership and status
    const result = await dynamo.send(new GetItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        sessionId: { S: sessionId },
      },
    }))

    if (!result.Item) {
      log('warn', 'CancelSession: session not found', { requestId, tenantId, sessionId })
      return errorResponse(404, 'Session not found', {}, origin)
    }

    const session = result.Item
    const sessionItemId = session.itemId?.S

    // Verify session belongs to the requested item
    if (sessionItemId !== itemId) {
      log('warn', 'CancelSession: itemId mismatch', { requestId, tenantId, sessionId })
      return errorResponse(404, 'Session not found', {}, origin)
    }

    const status = session.status?.S
    if (status !== 'not_started') {
      log('warn', 'CancelSession: cannot cancel session with status', { requestId, tenantId, sessionId, status })
      return errorResponse(409, 'Only not_started sessions can be cancelled', {}, origin)
    }

    // Soft-cancel: mark as "cancelled" so the pulse code returns a clear message if used
    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        sessionId: { S: sessionId },
      },
      UpdateExpression: 'SET #status = :cancelled, cancelledAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':cancelled': { S: 'cancelled' },
        ':now': { S: new Date().toISOString() },
      },
    }))

    log('info', 'CancelSession: session cancelled', { requestId, tenantId, itemId, sessionId })
    return createResponse(200, { message: 'Session cancelled' }, {}, origin)
  } catch (err) {
    log('error', 'CancelSession: unexpected error', { requestId, tenantId, sessionId, errorName: err.name })
    return errorResponse(500, 'Failed to cancel session', {}, origin)
  }
}
