// Feature: pulse-s2-s4-billing
// Shared monthly usage counter enforcement module for Pulse.
// Used by createItem, inviteReviewer, createPublicSession, createSelfSession.
// Centralizes check + lazy reset + atomic increment logic.

import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { resolveFeature } from './features.mjs'
import { log } from './utils.mjs'

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

/**
 * Valid monthly counter names that can be enforced.
 */
const VALID_COUNTERS = ['monthlyItemsCreated', 'monthlySessionsTotal', 'monthlyPublicSessionsTotal']

/**
 * Returns true if the given periodStart is in a calendar month strictly before
 * the current month. Used to determine if a free tier lazy reset is needed.
 *
 * @param {string} tier - Tenant tier name
 * @param {string|null} periodStart - ISO date string (e.g. "2026-03-01")
 * @returns {boolean}
 */
export function needsLazyReset(tier, periodStart) {
  if (tier !== 'free') return false
  if (!periodStart) return true // No periodStart means never initialized — reset

  const now = new Date()
  const currentYear = now.getUTCFullYear()
  const currentMonth = now.getUTCMonth() // 0-indexed

  const period = new Date(periodStart)
  if (isNaN(period.getTime())) return true // Invalid date — reset

  const periodYear = period.getUTCFullYear()
  const periodMonth = period.getUTCMonth()

  return periodYear < currentYear || (periodYear === currentYear && periodMonth < currentMonth)
}

/**
 * Calculates the reset date (first of next month) from a periodStart.
 *
 * @param {string} periodStart - ISO date string
 * @returns {string} ISO date string for first of next month
 */
export function calculateResetDate(periodStart) {
  const d = new Date(periodStart)
  if (isNaN(d.getTime())) {
    // Fallback: first of next month from now
    const now = new Date()
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().split('T')[0]
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().split('T')[0]
}

/**
 * Returns the first day of the current UTC month as an ISO date string.
 * @returns {string} e.g. "2026-04-01"
 */
function firstOfCurrentMonth() {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().split('T')[0]
}

/**
 * Check a monthly usage counter and increment if below limit.
 * Handles lazy reset for free tier, org-aware counter routing, and atomic increment.
 *
 * @param {object} params
 * @param {string} params.tenantId - The tenant performing the action
 * @param {string} params.counterName - One of VALID_COUNTERS
 * @param {object} params.tenantRecord - Unmarshalled tenant record { tier, features, serviceFlags, usageCounters, orgId? }
 * @param {object|null} params.systemRecord - Unmarshalled SYSTEM record
 * @param {string|null} [params.orgId] - If set, counters are read/incremented on the org record
 * @returns {Promise<{ allowed: boolean, reason?: string, counter?: string, resetDate?: string, newCount?: number }>}
 */
export async function checkAndIncrement({ tenantId, counterName, tenantRecord, systemRecord, orgId = null }) {
  if (!VALID_COUNTERS.includes(counterName)) {
    log('error', 'counters: invalid counter name', { tenantId, counterName })
    return { allowed: false, reason: 'invalid_counter' }
  }

  // Resolve the limit for this counter via feature flags
  const featureResult = resolveFeature(tenantRecord, counterName, systemRecord)
  if (!featureResult.allowed) {
    return { allowed: false, reason: featureResult.reason, counter: counterName }
  }
  const limit = featureResult.limit
  if (limit === null || limit === undefined) {
    // Boolean flag or no limit — allow without counter check
    return { allowed: true }
  }

  // Determine which record holds the counters (org or tenant)
  const tableName = process.env.TENANTS_TABLE
  let counterRecordId = tenantId
  let counterSource = 'tenant'

  if (orgId) {
    // Org-aware: try to read from org record in orgs table
    // For S4, org counters are on the org record in the orgs table.
    // However, orgs table is S5 scope. For now, if orgId is set but
    // ORGS_TABLE is not configured, fall back to tenant record.
    if (process.env.ORGS_TABLE) {
      counterRecordId = orgId
      counterSource = 'org'
    } else {
      log('warn', 'counters: orgId set but ORGS_TABLE not configured, using tenant counters', { tenantId, orgId })
    }
  }

  // Read current counter state
  let currentCount = 0
  let periodStart = firstOfCurrentMonth()

  try {
    const tableToQuery = counterSource === 'org' ? process.env.ORGS_TABLE : tableName
    const keyField = counterSource === 'org' ? 'orgId' : 'tenantId'

    const result = await dynamo.send(new GetItemCommand({
      TableName: tableToQuery,
      Key: { [keyField]: { S: counterRecordId } },
      ProjectionExpression: 'usageCounters, tier',
    }))

    if (!result.Item) {
      if (counterSource === 'org') {
        // Org record not found — fall back to tenant
        log('warn', 'counters: org record not found, falling back to tenant', { tenantId, orgId })
        counterRecordId = tenantId
        counterSource = 'tenant'
        // Re-read from tenant
        const tenantResult = await dynamo.send(new GetItemCommand({
          TableName: tableName,
          Key: { tenantId: { S: tenantId } },
          ProjectionExpression: 'usageCounters, tier',
        }))
        if (tenantResult.Item?.usageCounters?.M?.[counterName]?.M) {
          const counterMap = tenantResult.Item.usageCounters.M[counterName].M
          currentCount = counterMap.count?.N ? Number(counterMap.count.N) : 0
          periodStart = counterMap.periodStart?.S ?? firstOfCurrentMonth()
        }
      }
      // If tenant record also missing, defaults (count=0, periodStart=now) are fine
    } else {
      if (result.Item.usageCounters?.M?.[counterName]?.M) {
        const counterMap = result.Item.usageCounters.M[counterName].M
        currentCount = counterMap.count?.N ? Number(counterMap.count.N) : 0
        periodStart = counterMap.periodStart?.S ?? firstOfCurrentMonth()
      }
    }
  } catch (err) {
    log('error', 'counters: failed to read counter state', { tenantId, counterName, errorName: err.name })
    // On read failure, allow the action (fail-open for counters)
    return { allowed: true }
  }

  // Lazy reset for free tier
  const tier = tenantRecord?.tier ?? 'free'
  if (needsLazyReset(tier, periodStart)) {
    const newPeriodStart = firstOfCurrentMonth()
    try {
      const tableToUpdate = counterSource === 'org' ? process.env.ORGS_TABLE : tableName
      const keyField = counterSource === 'org' ? 'orgId' : 'tenantId'

      // Ensure parent map exists before setting nested counter
      await dynamo.send(new UpdateItemCommand({
        TableName: tableToUpdate,
        Key: { [keyField]: { S: counterRecordId } },
        UpdateExpression: 'SET usageCounters = if_not_exists(usageCounters, :emptyMap)',
        ExpressionAttributeValues: { ':emptyMap': { M: {} } },
      }))

      await dynamo.send(new UpdateItemCommand({
        TableName: tableToUpdate,
        Key: { [keyField]: { S: counterRecordId } },
        UpdateExpression: 'SET usageCounters.#counter = :reset',
        ExpressionAttributeNames: { '#counter': counterName },
        ExpressionAttributeValues: {
          ':reset': { M: { count: { N: '0' }, periodStart: { S: newPeriodStart } } },
        },
      }))
      currentCount = 0
      periodStart = newPeriodStart
      log('info', 'counters: lazy reset applied', { tenantId, counterName, newPeriodStart })
    } catch (err) {
      log('warn', 'counters: lazy reset failed, using stale count', { tenantId, counterName, errorName: err.name })
    }
  }

  // Check limit
  const resetDate = calculateResetDate(periodStart)
  if (currentCount >= limit) {
    return { allowed: false, reason: 'monthly_limit', counter: counterName, resetDate }
  }

  // Atomic increment — ensure parent maps exist, then increment
  try {
    const tableToUpdate = counterSource === 'org' ? process.env.ORGS_TABLE : tableName
    const keyField = counterSource === 'org' ? 'orgId' : 'tenantId'

    // Two-step: first ensure usageCounters and the counter map exist, then increment.
    // DynamoDB ADD can't create nested paths — the parent map must exist.
    await dynamo.send(new UpdateItemCommand({
      TableName: tableToUpdate,
      Key: { [keyField]: { S: counterRecordId } },
      UpdateExpression: 'SET usageCounters = if_not_exists(usageCounters, :emptyMap)',
      ExpressionAttributeValues: {
        ':emptyMap': { M: {} },
      },
    }))

    await dynamo.send(new UpdateItemCommand({
      TableName: tableToUpdate,
      Key: { [keyField]: { S: counterRecordId } },
      UpdateExpression: 'SET usageCounters.#counter = if_not_exists(usageCounters.#counter, :initCounter)',
      ExpressionAttributeNames: { '#counter': counterName },
      ExpressionAttributeValues: {
        ':initCounter': { M: { count: { N: '0' }, periodStart: { S: periodStart } } },
      },
    }))

    await dynamo.send(new UpdateItemCommand({
      TableName: tableToUpdate,
      Key: { [keyField]: { S: counterRecordId } },
      UpdateExpression: 'ADD usageCounters.#counter.#count :inc',
      ExpressionAttributeNames: {
        '#counter': counterName,
        '#count': 'count',
      },
      ExpressionAttributeValues: {
        ':inc': { N: '1' },
      },
    }))

    log('info', 'counters: incremented', { tenantId, counterName, newCount: currentCount + 1 })
    return { allowed: true, newCount: currentCount + 1 }
  } catch (err) {
    log('error', 'counters: atomic increment failed', { tenantId, counterName, errorName: err.name })
    // On increment failure, block the action (fail-closed for writes)
    return { allowed: false, reason: 'counter_error', counter: counterName }
  }
}
