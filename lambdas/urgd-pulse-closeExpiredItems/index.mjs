// ur/gd pulse — Close Expired Items Lambda
// Two modes:
//   1. Targeted: EventBridge Scheduler fires with { itemId, tenantId } → close that specific item
//   2. Batch sweep: EventBridge rate rule (12h) fires with no itemId → scan for overdue active items
//
// Close logic per item:
//   - Verify item exists and is active (skip if not found or already closed)
//   - Set status → closed, closedAt → now
//   - Expire all non-terminal sessions (not completed, not expired)
//   - For in-progress sessions with transcript count > 3: invoke generateReport (async)
//   - After all sessions processed: invoke runPulseCheck + sendPulseCheckReady (async)

import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { log, requireEnv } from './shared/utils.mjs'

requireEnv([
  'ITEMS_TABLE',
  'SESSIONS_TABLE',
  'GENERATE_REPORT_FUNCTION_ARN',
  'RUN_PULSE_CHECK_FUNCTION_ARN',
  'SEND_PULSE_CHECK_READY_FUNCTION_ARN',
])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' })

const TERMINAL_STATUSES = new Set(['completed', 'expired'])
const MIN_TRANSCRIPT_COUNT = 3

export const handler = async (event) => {
  log('info', 'CloseExpiredItems: invoked', { event })

  // Targeted mode: EventBridge Scheduler sends { itemId, tenantId }
  if (event?.itemId && event?.tenantId) {
    await closeItem(event.itemId, event.tenantId)
    return { mode: 'targeted', itemId: event.itemId }
  }

  // Batch sweep mode: scan for active items past their close date
  return await batchSweep()
}

/**
 * Batch sweep: scan Items table for active items whose closeDate has passed.
 * Invoked by the 12-hour EventBridge rate rule as a safety backstop.
 */
async function batchSweep() {
  log('info', 'CloseExpiredItems: batch sweep started')
  const now = new Date().toISOString()
  let totalClosed = 0
  let totalSkipped = 0
  let lastKey

  do {
    const scanResult = await dynamo.send(new ScanCommand({
      TableName: process.env.ITEMS_TABLE,
      FilterExpression: '#status = :active AND attribute_exists(closeDate) AND closeDate < :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':active': { S: 'active' },
        ':now': { S: now },
      },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }))

    lastKey = scanResult.LastEvaluatedKey
    const items = scanResult.Items ?? []

    for (const item of items) {
      const itemId = item.itemId?.S
      const tenantId = item.tenantId?.S
      if (!itemId || !tenantId) {
        totalSkipped++
        continue
      }

      try {
        await closeItem(itemId, tenantId)
        totalClosed++
      } catch (err) {
        log('error', 'CloseExpiredItems: sweep failed for item', { itemId, tenantId, errorName: err.name })
        totalSkipped++
      }
    }
  } while (lastKey)

  log('info', 'CloseExpiredItems: batch sweep completed', { totalClosed, totalSkipped })
  return { mode: 'sweep', totalClosed, totalSkipped }
}

/**
 * Close a single item: set status → closed, expire non-terminal sessions,
 * trigger reports for in-progress sessions with transcript, then trigger pulse check.
 */
async function closeItem(itemId, tenantId) {
  log('info', 'CloseExpiredItems: closing item', { itemId, tenantId })

  // 1. Verify item exists and is active
  const itemResult = await dynamo.send(new GetItemCommand({
    TableName: process.env.ITEMS_TABLE,
    Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
  }))

  if (!itemResult.Item) {
    log('warn', 'CloseExpiredItems: item not found, skipping', { itemId, tenantId })
    return
  }

  const currentStatus = itemResult.Item.status?.S
  if (currentStatus === 'closed') {
    log('info', 'CloseExpiredItems: item already closed, skipping', { itemId, tenantId })
    return
  }

  const now = new Date().toISOString()

  // 2. Set item status → closed
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

  log('info', 'CloseExpiredItems: item status set to closed', { itemId, tenantId })

  // 3. Query all sessions for this item and expire non-terminal ones
  let expiredCount = 0
  let reportTriggered = 0
  let lastKey

  do {
    const sessionsResult = await dynamo.send(new QueryCommand({
      TableName: process.env.SESSIONS_TABLE,
      IndexName: 'item-index',
      KeyConditionExpression: 'itemId = :iid',
      FilterExpression: '#status <> :completed AND #status <> :expired AND tenantId = :tid',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':iid': { S: itemId },
        ':tid': { S: tenantId },
        ':completed': { S: 'completed' },
        ':expired': { S: 'expired' },
      },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }))

    lastKey = sessionsResult.LastEvaluatedKey
    const sessions = sessionsResult.Items ?? []

    for (const session of sessions) {
      const sessionId = session.sessionId?.S
      if (!sessionId) continue

      const sessionStatus = session.status?.S

      // For in-progress sessions with enough transcript, trigger report generation
      if (sessionStatus === 'in_progress') {
        try {
          const transcriptCount = await getTranscriptCount(sessionId)
          if (transcriptCount > MIN_TRANSCRIPT_COUNT) {
            await lambda.send(new InvokeCommand({
              FunctionName: process.env.GENERATE_REPORT_FUNCTION_ARN,
              InvocationType: 'Event',
              Payload: JSON.stringify({ sessionId, tenantId, incomplete: true }),
            }))
            log('info', 'CloseExpiredItems: triggered report for in-progress session', { itemId, sessionId, transcriptCount })
            reportTriggered++
          }
        } catch (err) {
          log('warn', 'CloseExpiredItems: failed to trigger report', { itemId, sessionId, errorName: err.name })
        }
      }

      // Expire the session
      try {
        await dynamo.send(new UpdateItemCommand({
          TableName: process.env.SESSIONS_TABLE,
          Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
          UpdateExpression: 'SET #status = :expired, expiredAt = :now',
          ConditionExpression: '#status <> :completed',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':expired': { S: 'expired' },
            ':now': { S: now },
            ':completed': { S: 'completed' },
          },
        }))
        expiredCount++
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') {
          log('info', 'CloseExpiredItems: session already in terminal state, skipping', { itemId, sessionId })
        } else {
          log('error', 'CloseExpiredItems: failed to expire session', { itemId, sessionId, errorName: err.name })
        }
      }
    }
  } while (lastKey)

  log('info', 'CloseExpiredItems: sessions processed', { itemId, tenantId, expiredCount, reportTriggered })

  // 4. Trigger runPulseCheck and sendPulseCheckReady — only if there are completed sessions
  // Items with zero sessions should not fire pulse check emails
  const completedSessionsResult = await dynamo.send(new QueryCommand({
    TableName: process.env.SESSIONS_TABLE,
    IndexName: 'item-index',
    KeyConditionExpression: 'itemId = :iid',
    FilterExpression: '#status = :completed AND tenantId = :tid',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':iid': { S: itemId },
      ':tid': { S: tenantId },
      ':completed': { S: 'completed' },
    },
    Select: 'COUNT',
  }))

  const completedCount = completedSessionsResult.Count ?? 0
  if (completedCount > 0) {
    await triggerPulseCheck(itemId, tenantId)
  } else {
    log('info', 'CloseExpiredItems: no completed sessions, skipping pulse check and notification', { itemId, tenantId })
  }
}

/**
 * Count transcript records for a session (used to decide whether to trigger report generation).
 */
async function getTranscriptCount(sessionId) {
  const transcriptsTable = process.env.TRANSCRIPTS_TABLE
  if (!transcriptsTable) return 0

  const result = await dynamo.send(new QueryCommand({
    TableName: transcriptsTable,
    KeyConditionExpression: 'sessionId = :sid',
    ExpressionAttributeValues: { ':sid': { S: sessionId } },
    Select: 'COUNT',
  }))

  return result.Count ?? 0
}

/**
 * Invoke runPulseCheck and sendPulseCheckReady async (fire-and-forget).
 * Failures are logged but do not block the close operation.
 */
async function triggerPulseCheck(itemId, tenantId) {
  // Get item name for the notification
  let itemName = 'your item'
  try {
    const itemResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
      ProjectionExpression: 'itemName',
    }))
    itemName = itemResult.Item?.itemName?.S ?? 'your item'
  } catch (err) {
    log('warn', 'CloseExpiredItems: failed to fetch item name for notification', { itemId, errorName: err.name })
  }

  try {
    await lambda.send(new InvokeCommand({
      FunctionName: process.env.RUN_PULSE_CHECK_FUNCTION_ARN,
      InvocationType: 'Event',
      Payload: JSON.stringify({ tenantId, itemId }),
    }))
    log('info', 'CloseExpiredItems: runPulseCheck invoked', { itemId, tenantId })
  } catch (err) {
    log('error', 'CloseExpiredItems: failed to invoke runPulseCheck', { itemId, tenantId, errorName: err.name })
  }

  try {
    await lambda.send(new InvokeCommand({
      FunctionName: process.env.SEND_PULSE_CHECK_READY_FUNCTION_ARN,
      InvocationType: 'Event',
      Payload: JSON.stringify({ tenantId, itemId, itemName }),
    }))
    log('info', 'CloseExpiredItems: sendPulseCheckReady invoked', { itemId, tenantId })
  } catch (err) {
    log('error', 'CloseExpiredItems: failed to invoke sendPulseCheckReady', { itemId, tenantId, errorName: err.name })
  }
}
