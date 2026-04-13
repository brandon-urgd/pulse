// ur/gd pulse — Accept Confidentiality Lambda
// POST /api/session/{sessionId}/accept-confidentiality
// Updates session record with confidentialityAcceptedAt timestamp

import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

// Fail-fast env var validation
requireEnv(['SESSIONS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const lambda = process.env.PRE_GENERATE_FUNCTION_ARN
  ? new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' })
  : null

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  // sessionId and tenantId come from the session authorizer context
  const sessionId = event?.requestContext?.authorizer?.sessionId
  const tenantId = event?.requestContext?.authorizer?.tenantId

  if (!sessionId || !tenantId) {
    log('warn', 'AcceptConfidentiality: missing sessionId or tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  try {
    const now = new Date().toISOString()

    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        sessionId: { S: sessionId },
      },
      UpdateExpression: 'SET confidentialityAcceptedAt = :acceptedAt',
      ExpressionAttributeValues: {
        ':acceptedAt': { S: now },
      },
    }))

    log('info', 'AcceptConfidentiality: accepted', { requestId, sessionId, tenantId })

    // Fire-and-forget: invoke PreGenerate Lambda to pre-generate the greeting
    if (lambda && process.env.PRE_GENERATE_FUNCTION_ARN) {
      try {
        await lambda.send(new InvokeCommand({
          FunctionName: process.env.PRE_GENERATE_FUNCTION_ARN,
          InvocationType: 'Event',
          Payload: JSON.stringify({ tenantId, sessionId }),
        }))
        log('info', 'AcceptConfidentiality: preGenerate invoked', { requestId, sessionId, tenantId })
      } catch (invokeErr) {
        log('warn', 'AcceptConfidentiality: failed to invoke preGenerate', { requestId, sessionId, tenantId, errorName: invokeErr.name })
      }
    }

    return createResponse(200, { data: { sessionId, confidentialityAcceptedAt: now } }, {}, origin)
  } catch (err) {
    log('error', 'AcceptConfidentiality: unexpected error', { requestId, sessionId, tenantId, errorName: err.name })
    return errorResponse(500, 'Failed to record confidentiality acceptance', {}, origin)
  }
}
