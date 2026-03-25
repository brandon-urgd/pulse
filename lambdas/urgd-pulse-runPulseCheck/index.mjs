// ur/gd pulse — Run Pulse Check Lambda
// POST /api/manage/items/{itemId}/pulse-check
//
// Gate + dispatcher: validates sessions, writes status:'generating' to DynamoDB,
// fires processPulseCheck async (InvocationType: Event), returns 202 immediately.
// The frontend polls GET /pulse-check until status flips to 'complete' or 'failed'.

import { DynamoDBClient, QueryCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv([
  'SESSIONS_TABLE', 'PULSE_CHECKS_TABLE',
  'PROCESS_FUNCTION_NAME', 'CORS_ALLOWED_ORIGINS',
])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  // Support both API Gateway (authorizer context) and direct async invocation
  const tenantId = event?.requestContext?.authorizer?.tenantId ?? event?.tenantId
  const itemId = event?.pathParameters?.itemId ?? event?.itemId

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

    // 2. Filter out not_started sessions — they haven't begun and contribute nothing.
    //    in_progress sessions are underway and will complete naturally; the re-run
    //    banner handles including them after they finish.
    const activeSessions = sessions.filter(s => s.status?.S !== 'not_started' && s.status?.S !== 'cancelled')
    if (activeSessions.length === 0) return errorResponse(404, 'No completed sessions to analyze', {}, origin)

    const inProgressCount = activeSessions.filter(s => s.status?.S === 'in_progress').length
    const startedAt = new Date().toISOString()

    // 3. Write 'generating' sentinel so the frontend polling loop has something to watch
    await dynamo.send(new PutItemCommand({
      TableName: process.env.PULSE_CHECKS_TABLE,
      Item: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
        status: { S: 'generating' },
        generatedAt: { S: startedAt },
        sessionCount: { N: String(activeSessions.length) },
        incompleteCount: { N: String(inProgressCount) },
      },
    }))

    // 4. Fire processPulseCheck async — InvocationType: Event means fire-and-forget
    await lambda.send(new InvokeCommand({
      FunctionName: process.env.PROCESS_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: JSON.stringify({ tenantId, itemId, startedAt }),
    }))

    log('info', 'RunPulseCheck: dispatched to processPulseCheck', { requestId, tenantId, itemId })

    return createResponse(202, { status: 'generating' }, {}, origin)
  } catch (err) {
    log('error', 'RunPulseCheck: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to start pulse check', {}, origin)
  }
}
