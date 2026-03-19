// ur/gd pulse — Expire Sessions Lambda (scheduled job)
// Triggered by EventBridge every 6 hours
// Scans sessions where expiresAt has passed and status is not "completed"
// Updates status to "expired" — never modifies "completed" sessions

import { DynamoDBClient, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { log, requireEnv } from './shared/utils.mjs'

// Fail-fast env var validation
requireEnv(['SESSIONS_TABLE'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  log('info', 'ExpireSessions: job started', { trigger: event?.source ?? 'unknown' })

  const now = new Date().toISOString()
  let totalScanned = 0
  let totalExpired = 0
  let totalSkipped = 0
  let lastEvaluatedKey

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

  return { totalScanned, totalExpired, totalSkipped }
}
