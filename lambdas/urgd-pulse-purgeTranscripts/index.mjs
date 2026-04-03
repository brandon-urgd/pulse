// ur/gd pulse — Purge Transcripts Lambda (scheduled job)
// Triggered by EventBridge daily at 3 AM UTC
// Scans pulse checks where generatedAt < now - 30 days
// For each eligible pulse check, queries sessions and deletes transcript records
// Preserves session metadata, reports, and pulse check records
// Idempotent: re-running on already-purged data is a no-op

import { DynamoDBClient, ScanCommand, QueryCommand, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb'
import { log, requireEnv } from './shared/utils.mjs'

requireEnv(['PULSE_CHECKS_TABLE', 'SESSIONS_TABLE', 'TRANSCRIPTS_TABLE'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const BATCH_SIZE = 25
const MAX_UNPROCESSED_RETRIES = 3

export const handler = async (event) => {
  log('info', 'PurgeTranscripts: job started', { trigger: event?.source ?? 'unknown' })

  const cutoffDate = new Date(Date.now() - THIRTY_DAYS_MS).toISOString()
  let totalPulseChecksScanned = 0
  let totalTranscriptsDeleted = 0
  let totalSessionsProcessed = 0
  let lastEvaluatedKey

  // 1. Scan PULSE_CHECKS_TABLE for records where generatedAt < cutoff
  do {
    const scanResult = await dynamo.send(new ScanCommand({
      TableName: process.env.PULSE_CHECKS_TABLE,
      FilterExpression: 'attribute_exists(generatedAt) AND generatedAt < :cutoff',
      ExpressionAttributeValues: {
        ':cutoff': { S: cutoffDate },
      },
      ProjectionExpression: 'tenantId, itemId',
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    }))

    lastEvaluatedKey = scanResult.LastEvaluatedKey
    const eligibleChecks = scanResult.Items ?? []
    totalPulseChecksScanned += eligibleChecks.length

    // 2. For each eligible pulse check, get sessions and delete transcripts
    for (const pulseCheck of eligibleChecks) {
      const tenantId = pulseCheck.tenantId?.S
      const itemId = pulseCheck.itemId?.S

      if (!tenantId || !itemId) {
        log('warn', 'PurgeTranscripts: skipping pulse check with missing keys', {})
        continue
      }

      try {
        const deletedCount = await purgeTranscriptsForItem(tenantId, itemId)
        totalTranscriptsDeleted += deletedCount
        if (deletedCount > 0) {
          log('info', 'PurgeTranscripts: transcripts purged for item', { tenantId, itemId, deletedCount })
        }
      } catch (err) {
        log('error', 'PurgeTranscripts: failed to purge transcripts for item', { tenantId, itemId, errorName: err.name })
      }
    }
  } while (lastEvaluatedKey)

  log('info', 'PurgeTranscripts: job completed', {
    totalPulseChecksScanned,
    totalSessionsProcessed,
    totalTranscriptsDeleted,
  })

  return { totalPulseChecksScanned, totalSessionsProcessed, totalTranscriptsDeleted }

  /**
   * Queries all sessions for a given tenantId + itemId, then deletes all transcript
   * records for each session via BatchWriteItem.
   */
  async function purgeTranscriptsForItem(tenantId, itemId) {
    let deletedCount = 0
    let sessionLastKey

    // Query sessions using the item-index GSI
    do {
      const sessionsResult = await dynamo.send(new QueryCommand({
        TableName: process.env.SESSIONS_TABLE,
        IndexName: 'item-index',
        KeyConditionExpression: 'itemId = :itemId',
        ExpressionAttributeValues: { ':itemId': { S: itemId } },
        ProjectionExpression: 'sessionId',
        ...(sessionLastKey ? { ExclusiveStartKey: sessionLastKey } : {}),
      }))

      sessionLastKey = sessionsResult.LastEvaluatedKey
      const sessions = sessionsResult.Items ?? []

      for (const session of sessions) {
        const sessionId = session.sessionId?.S
        if (!sessionId) continue

        totalSessionsProcessed++
        deletedCount += await deleteTranscriptsForSession(sessionId)
      }
    } while (sessionLastKey)

    return deletedCount
  }

  /**
   * Queries all transcript records for a session and deletes them in batches of 25.
   * Handles pagination on the query and UnprocessedItems on BatchWriteItem.
   */
  async function deleteTranscriptsForSession(sessionId) {
    let deletedCount = 0
    let transcriptLastKey

    do {
      const transcriptResult = await dynamo.send(new QueryCommand({
        TableName: process.env.TRANSCRIPTS_TABLE,
        KeyConditionExpression: 'sessionId = :sid',
        ExpressionAttributeValues: { ':sid': { S: sessionId } },
        ProjectionExpression: 'sessionId, messageId',
        ...(transcriptLastKey ? { ExclusiveStartKey: transcriptLastKey } : {}),
      }))

      transcriptLastKey = transcriptResult.LastEvaluatedKey
      const items = transcriptResult.Items ?? []

      if (items.length === 0) continue

      // Batch delete in groups of 25
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE)
        const deleteRequests = batch.map(item => ({
          DeleteRequest: {
            Key: {
              sessionId: { S: item.sessionId.S },
              messageId: { S: item.messageId.S },
            },
          },
        }))

        let unprocessed = { [process.env.TRANSCRIPTS_TABLE]: deleteRequests }
        let retries = 0

        while (unprocessed[process.env.TRANSCRIPTS_TABLE]?.length > 0 && retries <= MAX_UNPROCESSED_RETRIES) {
          const result = await dynamo.send(new BatchWriteItemCommand({
            RequestItems: unprocessed,
          }))

          const processed = unprocessed[process.env.TRANSCRIPTS_TABLE].length -
            (result.UnprocessedItems?.[process.env.TRANSCRIPTS_TABLE]?.length ?? 0)
          deletedCount += processed

          unprocessed = result.UnprocessedItems ?? {}

          if (unprocessed[process.env.TRANSCRIPTS_TABLE]?.length > 0) {
            retries++
            if (retries <= MAX_UNPROCESSED_RETRIES) {
              // Exponential backoff: 100ms, 200ms, 400ms
              await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, retries - 1)))
              log('warn', 'PurgeTranscripts: retrying unprocessed items', {
                sessionId,
                unprocessedCount: unprocessed[process.env.TRANSCRIPTS_TABLE].length,
                retry: retries,
              })
            } else {
              log('error', 'PurgeTranscripts: max retries reached for unprocessed items', {
                sessionId,
                unprocessedCount: unprocessed[process.env.TRANSCRIPTS_TABLE].length,
              })
            }
          }
        }
      }
    } while (transcriptLastKey)

    return deletedCount
  }
}
