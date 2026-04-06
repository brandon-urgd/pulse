// ur/gd pulse — Expire Sessions Lambda (scheduled job)
// Triggered by EventBridge every 6 hours
// Scans sessions where expiresAt has passed and status is not "completed"
// Updates status to "expired" — never modifies "completed" sessions
// For in_progress sessions with ≥ 4 reviewer messages, invokes generateReport async
// before expiring so partial feedback is captured in the pulse check
//
// After expiring sessions, groups expired sessions by itemId.
// For each affected item, checks if ALL sessions are now terminal (completed/expired).
// If so, invokes runPulseCheck and sendPulseCheckReady async (fire-and-forget).
// NOTE: Item closing is NOT performed here — that is the sole responsibility of
// closeExpiredItems Lambda (Slice 3 — R1.8).

import { DynamoDBClient, ScanCommand, UpdateItemCommand, QueryCommand, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { log, requireEnv } from './shared/utils.mjs'

// Fail-fast env var validation
requireEnv(['SESSIONS_TABLE'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' })

const MIN_REVIEWER_MESSAGES = 4

export const handler = async (event) => {
  log('info', 'ExpireSessions: job started', { trigger: event?.source ?? 'unknown' })

  const now = new Date().toISOString()
  let totalScanned = 0
  let totalExpired = 0
  let totalSkipped = 0
  let lastEvaluatedKey
  // Track which items had sessions expire this run: Map<itemId, { tenantId }>
  const expiredByItem = new Map()

  // Scan all sessions — filter for those with expiresAt in the past and not completed
  do {
    const scanResult = await dynamo.send(new ScanCommand({
      TableName: process.env.SESSIONS_TABLE,
      FilterExpression: 'attribute_exists(expiresAt) AND expiresAt < :now AND #status <> :completed AND #status <> :expired',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':now': { S: now },
        ':completed': { S: 'completed' },
        ':expired': { S: 'expired' },
      },
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    }))

    lastEvaluatedKey = scanResult.LastEvaluatedKey
    const sessions = scanResult.Items ?? []
    totalScanned += sessions.length

    for (const session of sessions) {
      const tenantId = session.tenantId?.S
      const sessionId = session.sessionId?.S
      const currentStatus = session.status?.S

      if (!tenantId || !sessionId) {
        log('warn', 'ExpireSessions: skipping session with missing PK/SK', { sessionId })
        totalSkipped++
        continue
      }

      // Double-check: never touch completed sessions (belt-and-suspenders beyond the filter)
      if (currentStatus === 'completed') {
        totalSkipped++
        continue
      }

      // For in_progress sessions with enough transcript, fire generateReport before expiring
      // so partial feedback is captured. Fire-and-forget (async) — don't block expiry.
      if (currentStatus === 'in_progress') {
        const generateReportFnName = process.env.GENERATE_REPORT_FUNCTION_NAME
        const transcriptsTable = process.env.TRANSCRIPTS_TABLE
        if (generateReportFnName && transcriptsTable) {
          try {
            const transcriptResult = await dynamo.send(new QueryCommand({
              TableName: transcriptsTable,
              KeyConditionExpression: 'sessionId = :sid',
              ExpressionAttributeValues: { ':sid': { S: sessionId } },
              ProjectionExpression: 'messageId, #r',
              ExpressionAttributeNames: { '#r': 'role' },
            }))
            const reviewerMessages = (transcriptResult.Items ?? []).filter(m => m.role?.S === 'reviewer')
            if (reviewerMessages.length >= MIN_REVIEWER_MESSAGES) {
              await lambda.send(new InvokeCommand({
                FunctionName: generateReportFnName,
                InvocationType: 'Event',
                Payload: JSON.stringify({ sessionId, tenantId, incomplete: true }),
              }))
              log('info', 'ExpireSessions: triggered partial report', { tenantId, sessionId, reviewerMessages: reviewerMessages.length })
            } else {
              log('info', 'ExpireSessions: skipping partial report — too few messages', { tenantId, sessionId, reviewerMessages: reviewerMessages.length })
            }
          } catch (err) {
            log('warn', 'ExpireSessions: failed to trigger partial report', { tenantId, sessionId, errorName: err.name })
          }
        }
      }

      try {
        await dynamo.send(new UpdateItemCommand({
          TableName: process.env.SESSIONS_TABLE,
          Key: {
            tenantId: { S: tenantId },
            sessionId: { S: sessionId },
          },
          // Conditional expression: only update if status is still not "completed"
          ConditionExpression: '#status <> :completed',
          UpdateExpression: 'SET #status = :expired, expiredAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':expired': { S: 'expired' },
            ':completed': { S: 'completed' },
            ':now': { S: now },
          },
        }))

        log('info', 'ExpireSessions: session expired', { tenantId, sessionId })
        totalExpired++

        // Track this item for the post-loop pulse check trigger
        const itemId = session.itemId?.S
        if (itemId && !expiredByItem.has(itemId)) {
          expiredByItem.set(itemId, { tenantId })
        }
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') {
          // Session was completed between scan and update — skip safely
          log('info', 'ExpireSessions: session completed before expiry update, skipping', { tenantId, sessionId })
          totalSkipped++
        } else {
          log('error', 'ExpireSessions: failed to expire session', { tenantId, sessionId, errorName: err.name })
          totalSkipped++
        }
      }
    }
  } while (lastEvaluatedKey)

  log('info', 'ExpireSessions: job completed', { totalScanned, totalExpired, totalSkipped })

  // After expiring sessions, check each affected item to see if all sessions are now terminal.
  // NOTE: We do NOT auto-close items here. Items close on their closeDate (via closeExpiredItems
  // in Slice 3) or when the tenant manually closes them. An item with all sessions terminal
  // may still accept new invitations until its close date.
  // We DO trigger pulse check + notification if all real sessions are terminal, so the tenant
  // gets their results without waiting for the close date.
  if (expiredByItem.size > 0) {
    await triggerPulseChecksForTerminalItems(expiredByItem)
  }

  return { totalScanned, totalExpired, totalSkipped }
}

/**
 * For each item that had sessions expire this run, check if ALL real (non-preview) sessions
 * are now in a terminal state. If so, fire runPulseCheck and sendPulseCheckReady async
 * so the tenant gets results. Does NOT close the item — that's the tenant's decision
 * or the closeDate's job.
 */
async function triggerPulseChecksForTerminalItems(expiredByItem) {
  const runPulseCheckFnName = process.env.RUN_PULSE_CHECK_FUNCTION_NAME
  const sendReadyFnName = process.env.SEND_PULSE_CHECK_READY_FUNCTION_NAME
  const itemsTable = process.env.ITEMS_TABLE
  const now = new Date().toISOString()

  if (!runPulseCheckFnName || !sendReadyFnName) {
    log('info', 'ExpireSessions: pulse check trigger env vars not set, skipping auto-trigger')
    return
  }

  const TERMINAL_STATUSES = new Set(['completed', 'expired', 'cancelled', 'discarded'])

  for (const [itemId, { tenantId }] of expiredByItem.entries()) {
    try {
      // Query all sessions for this item
      const sessionsResult = await dynamo.send(new QueryCommand({
        TableName: process.env.SESSIONS_TABLE,
        IndexName: 'item-index',
        KeyConditionExpression: 'itemId = :itemId',
        ExpressionAttributeValues: { ':itemId': { S: itemId } },
        ProjectionExpression: 'sessionId, #status, preview',
        ExpressionAttributeNames: { '#status': 'status' },
      }))

      const sessions = sessionsResult.Items ?? []
      if (sessions.length === 0) continue

      // Exclude preview sessions — they're test runs, not real feedback.
      // An expired preview session should never trigger item auto-close.
      const realSessions = sessions.filter(s => s.preview?.BOOL !== true)
      if (realSessions.length === 0) continue

      // Check if every real session is now terminal
      const allTerminal = realSessions.every(s => TERMINAL_STATUSES.has(s.status?.S))
      if (!allTerminal) {
        log('info', 'ExpireSessions: item still has open sessions, skipping auto-trigger', { tenantId, itemId })
        continue
      }

      // Only auto-close the item if the closeDate has passed.
      // NOTE (Slice 3 — R1.8): Item closing is now the sole responsibility of
      // closeExpiredItems Lambda. We no longer auto-close items here.
      // We DO trigger pulse check + notification if all real sessions are terminal,
      // so the tenant gets their results without waiting for the close date.

      // Get item name for the notification email
      let itemName = 'your item'
      if (itemsTable) {
        try {
          const itemResult = await dynamo.send(new GetItemCommand({
            TableName: itemsTable,
            Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
            ProjectionExpression: 'itemName',
          }))
          itemName = itemResult.Item?.itemName?.S ?? 'your item'
        } catch (err) {
          log('warn', 'ExpireSessions: failed to fetch item name', { tenantId, itemId, errorName: err.name })
        }
      }

      log('info', 'ExpireSessions: all sessions terminal, triggering pulse check', { tenantId, itemId })

      // Invoke runPulseCheck async (fire-and-forget)
      try {
        await lambda.send(new InvokeCommand({
          FunctionName: runPulseCheckFnName,
          InvocationType: 'Event',
          Payload: JSON.stringify({ tenantId, itemId }),
        }))
        log('info', 'ExpireSessions: runPulseCheck invoked', { tenantId, itemId })
      } catch (err) {
        log('warn', 'ExpireSessions: failed to invoke runPulseCheck', { tenantId, itemId, errorName: err.name })
      }

      // NOTE: sendPulseCheckReady is NOT invoked here — the tenant notification
      // email should only fire when the item is actually closed (via closeExpiredItems),
      // not just because all sessions are terminal. The tenant may still want to
      // invite more reviewers while the item is open.
    } catch (err) {
      log('error', 'ExpireSessions: error checking item for auto-trigger', { tenantId, itemId, errorName: err.name })
    }
  }
}
