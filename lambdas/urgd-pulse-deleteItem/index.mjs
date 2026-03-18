// ur/gd pulse — Delete Item Lambda
// DELETE /api/manage/items/{itemId} → cascading delete across all related tables and S3

import { DynamoDBClient, GetItemCommand, QueryCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

// Fail-fast env var validation
requireEnv([
  'ITEMS_TABLE',
  'SESSIONS_TABLE',
  'TRANSCRIPTS_TABLE',
  'REPORTS_TABLE',
  'PULSE_CHECKS_TABLE',
  'DATA_BUCKET_NAME',
  'CORS_ALLOWED_ORIGINS',
])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })

/**
 * Query all items from a GSI by itemId.
 * Returns array of raw DynamoDB items.
 */
async function queryByItemId(tableName, indexName, itemId) {
  const items = []
  let lastKey
  do {
    const result = await dynamo.send(new QueryCommand({
      TableName: tableName,
      IndexName: indexName,
      KeyConditionExpression: 'itemId = :iid',
      ExpressionAttributeValues: { ':iid': { S: itemId } },
      ExclusiveStartKey: lastKey,
    }))
    items.push(...(result.Items ?? []))
    lastKey = result.LastEvaluatedKey
  } while (lastKey)
  return items
}

/**
 * Query all transcripts for a session.
 */
async function queryTranscriptsBySession(sessionId) {
  const items = []
  let lastKey
  do {
    const result = await dynamo.send(new QueryCommand({
      TableName: process.env.TRANSCRIPTS_TABLE,
      KeyConditionExpression: 'sessionId = :sid',
      ExpressionAttributeValues: { ':sid': { S: sessionId } },
      ExclusiveStartKey: lastKey,
    }))
    items.push(...(result.Items ?? []))
    lastKey = result.LastEvaluatedKey
  } while (lastKey)
  return items
}

/**
 * Delete all S3 objects under a given prefix (paginated list + batch delete).
 */
async function deleteS3Prefix(bucket, prefix) {
  let continuationToken
  do {
    const listResult = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }))

    const objects = listResult.Contents ?? []
    if (objects.length > 0) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: objects.map(o => ({ Key: o.Key })),
          Quiet: true,
        },
      }))
    }

    continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined
  } while (continuationToken)
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) {
    log('warn', 'DeleteItem: missing tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!itemId) {
    return errorResponse(400, 'Missing itemId', {}, origin)
  }

  log('info', 'DeleteItem: starting cascading delete', { requestId, tenantId, itemId })

  try {
    // 1. Get item record (404 if not found)
    const itemResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
      },
    }))

    if (!itemResult.Item) {
      log('warn', 'DeleteItem: item not found', { requestId, tenantId, itemId })
      return errorResponse(404, 'Item not found', {}, origin)
    }

    // 2. Query PulseSessionsTable for all sessions with itemId (item-index GSI)
    const sessions = await queryByItemId(process.env.SESSIONS_TABLE, 'item-index', itemId)
    log('info', 'DeleteItem: found sessions', { requestId, tenantId, itemId, sessionCount: sessions.length })

    // 3. For each session, query and delete all transcripts
    for (const session of sessions) {
      const sessionId = session.sessionId?.S
      if (!sessionId) continue

      const transcripts = await queryTranscriptsBySession(sessionId)
      for (const transcript of transcripts) {
        const messageId = transcript.messageId?.S
        if (!messageId) continue
        await dynamo.send(new DeleteItemCommand({
          TableName: process.env.TRANSCRIPTS_TABLE,
          Key: {
            sessionId: { S: sessionId },
            messageId: { S: messageId },
          },
        }))
      }
      log('info', 'DeleteItem: deleted transcripts for session', { requestId, tenantId, itemId, sessionId, count: transcripts.length })
    }

    // 4. Delete all session records
    for (const session of sessions) {
      const sessionId = session.sessionId?.S
      const sessionTenantId = session.tenantId?.S
      if (!sessionId || !sessionTenantId) continue
      await dynamo.send(new DeleteItemCommand({
        TableName: process.env.SESSIONS_TABLE,
        Key: {
          tenantId: { S: sessionTenantId },
          sessionId: { S: sessionId },
        },
      }))
    }
    log('info', 'DeleteItem: deleted sessions', { requestId, tenantId, itemId, count: sessions.length })

    // 5. Query PulseReportsTable for all reports with itemId (item-index GSI)
    const reports = await queryByItemId(process.env.REPORTS_TABLE, 'item-index', itemId)
    log('info', 'DeleteItem: found reports', { requestId, tenantId, itemId, reportCount: reports.length })

    // 6. Delete all report records
    for (const report of reports) {
      const sessionId = report.sessionId?.S
      const reportTenantId = report.tenantId?.S
      if (!sessionId || !reportTenantId) continue
      await dynamo.send(new DeleteItemCommand({
        TableName: process.env.REPORTS_TABLE,
        Key: {
          tenantId: { S: reportTenantId },
          sessionId: { S: sessionId },
        },
      }))
    }
    log('info', 'DeleteItem: deleted reports', { requestId, tenantId, itemId, count: reports.length })

    // 7. Delete pulse check record from PulsePulseChecksTable (if exists)
    await dynamo.send(new DeleteItemCommand({
      TableName: process.env.PULSE_CHECKS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
      },
    }))
    log('info', 'DeleteItem: deleted pulse check (if existed)', { requestId, tenantId, itemId })

    // 8. Delete all S3 objects under pulse/{tenantId}/items/{itemId}/
    const s3Prefix = `pulse/${tenantId}/items/${itemId}/`
    await deleteS3Prefix(process.env.DATA_BUCKET_NAME, s3Prefix)
    log('info', 'DeleteItem: deleted S3 objects', { requestId, tenantId, itemId, prefix: s3Prefix })

    // 9. Delete item record from DynamoDB
    await dynamo.send(new DeleteItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
      },
    }))

    log('info', 'DeleteItem: cascading delete complete', { requestId, tenantId, itemId })

    return createResponse(200, { message: 'Item deleted' }, {}, origin)
  } catch (err) {
    log('error', 'DeleteItem: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to delete item', {}, origin)
  }
}
