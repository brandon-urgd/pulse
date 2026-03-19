// ur/gd pulse — Delete Session Transcript Lambda
// DELETE /api/session/{sessionId}/transcript
// Discards a session by deleting all transcript records and marking status as 'discarded'

import { DynamoDBClient, GetItemCommand, QueryCommand, BatchWriteItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['SESSIONS_TABLE', 'TRANSCRIPTS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const sessionId = event?.requestContext?.authorizer?.sessionId
  const tenantId = event?.requestContext?.authorizer?.tenantId

  if (!sessionId || !tenantId) {
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  try {
    // 1. Get session record
    const sessionResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
    }))

    if (!sessionResult.Item) {
      return errorResponse(404, 'Session not found', {}, origin)
    }

    const session = sessionResult.Item

    // 2. If status is completed, return 409
    if (session.status?.S === 'completed') {
      return errorResponse(409, 'Cannot discard a completed session', {}, origin)
    }

    // 3. Query all transcript records
    const transcriptResult = await dynamo.send(new QueryCommand({
      TableName: process.env.TRANSCRIPTS_TABLE,
      KeyConditionExpression: 'sessionId = :sid',
      ExpressionAttributeValues: { ':sid': { S: sessionId } },
      ProjectionExpression: 'sessionId, messageId',
    }))

    const items = transcriptResult.Items || []

    // 4. BatchWriteItem to delete all transcript records (25 per batch)
    if (items.length > 0) {
      const batches = []
      for (let i = 0; i < items.length; i += 25) {
        batches.push(items.slice(i, i + 25))
      }

      for (const batch of batches) {
        await dynamo.send(new BatchWriteItemCommand({
          RequestItems: {
            [process.env.TRANSCRIPTS_TABLE]: batch.map(item => ({
              DeleteRequest: {
                Key: {
                  sessionId: { S: item.sessionId.S },
                  messageId: { S: item.messageId.S },
                },
              },
            })),
          },
        }))
      }
    }

    // 5. Update session status to 'discarded'
    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
      UpdateExpression: 'SET #status = :status, discardedAt = :discardedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': { S: 'discarded' },
        ':discardedAt': { S: new Date().toISOString() },
      },
    }))

    log('info', 'DeleteSessionTranscript: discarded', { requestId, sessionId, tenantId, deletedCount: items.length })

    // 6. Return 200
    return createResponse(200, { data: { discarded: true } }, {}, origin)
  } catch (err) {
    log('error', 'DeleteSessionTranscript: unexpected error', { requestId, sessionId, tenantId, errorName: err.name })
    return errorResponse(500, 'Failed to discard session', {}, origin)
  }
}
