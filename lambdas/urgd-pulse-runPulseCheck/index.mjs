// ur/gd pulse — Run Pulse Check Lambda
// POST /api/manage/items/{itemId}/pulse-check
//
// ASYNC PATTERN: API Gateway REST has a hard 29s integration timeout.
// This lambda validates, writes 'generating', fires processPulseCheck async
// (InvocationType: Event — fire and forget), then returns 202 immediately.
// The frontend polls GET /pulse-check until status === 'complete' | 'failed'.

import { DynamoDBClient, QueryCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv([
  'REPORTS_TABLE', 'PULSE_CHECKS_TABLE', 'SESSIONS_TABLE',
  'PROCESS_FUNCTION_NAME', 'CORS_ALLOWED_ORIGINS',
])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) return errorResponse(401, 'Unauthorized', {}, origin)
  if (!itemId) return errorResponse(400, 'itemId is required', {}, origin)

  try {
    // 1. Query all sessions for this item
    const sessionsResult = await dynamo.send(new QueryCommand({
      TableName: process.env.SESSIONS_TABLE,
      IndexName: 'item-index',
      KeyConditionExpression: 'itemId = :itemId',
      ExpressionAttributeValues: { ':itemId': { S: itemId } },
      ProjectionExpression: 'sessionId, #status',
      ExpressionAttributeNames: { '#status': 'status' },
    }))

    const sessions = sessionsResult.Items || []
    if (sessions.length === 0) return errorResponse(404, 'No sessions found for this item', {}, origin)

    // 2. Validate all sessions are terminal
    const TERMINAL_STATUSES = new Set(['completed', 'expired', 'cancelled', 'discarded'])
    const openSessions = sessions.filter(s => !TERMINAL_STATUSES.has(s.status?.S))
    if (openSessions.length > 0) {
      log('warn', 'RunPulseCheck: open sessions remain', { requestId, tenantId, itemId, openCount: openSessions.length })
      return errorResponse(409, 'Not all sessions are closed. Wait for remaining sessions to complete or expire.', {}, origin)
    }

    // 3. Write 'generating' placeholder — processPulseCheck will overwrite with 'complete'
    const startedAt = new Date().toISOString()
    await dynamo.send(new PutItemCommand({
      TableName: process.env.PULSE_CHECKS_TABLE,
      Item: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
        status: { S: 'generating' },
        generatedAt: { S: startedAt },
      },
    }))

    // 4. Fire processPulseCheck async — InvocationType Event = fire and forget
    await lambda.send(new InvokeCommand({
      FunctionName: process.env.PROCESS_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: JSON.stringify({ tenantId, itemId, startedAt, origin }),
    }))

    log('info', 'RunPulseCheck: async processing started', { requestId, tenantId, itemId })
    return createResponse(202, { data: { status: 'generating', itemId } }, {}, origin)
  } catch (err) {
    log('error', 'RunPulseCheck: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to run pulse check', {}, origin)
  }
}
