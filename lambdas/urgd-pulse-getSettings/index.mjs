// ur/gd pulse — Get Settings Lambda
// GET /api/manage/settings → returns tenant settings with live usage counts

import { DynamoDBClient, BatchGetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { resolveAllFeatures } from './shared/features.mjs'

requireEnv(['TENANTS_TABLE', 'ITEMS_TABLE', 'SESSIONS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

function unmarshal(item) {
  if (!item) return null
  const result = {}
  for (const [key, val] of Object.entries(item)) {
    if ('S' in val) result[key] = val.S
    else if ('N' in val) result[key] = Number(val.N)
    else if ('BOOL' in val) result[key] = val.BOOL
    else if ('M' in val) result[key] = unmarshal(val.M)
    else if ('L' in val) result[key] = val.L.map(v => unmarshal({ _: v })._)
    else if ('NULL' in val) result[key] = null
  }
  return result
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId

  if (!tenantId) {
    log('warn', 'GetSettings: missing tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  log('info', 'GetSettings: fetching tenant', { requestId, tenantId })

  try {
    const [batchResult, itemsResult, sessionsResult] = await Promise.all([
      dynamo.send(new BatchGetItemCommand({
        RequestItems: {
          [process.env.TENANTS_TABLE]: {
            Keys: [
              { tenantId: { S: tenantId } },
              { tenantId: { S: 'SYSTEM' } },
            ],
          },
        },
      })),
      // Count active/draft items for this tenant
      dynamo.send(new QueryCommand({
        TableName: process.env.ITEMS_TABLE,
        KeyConditionExpression: 'tenantId = :tid',
        FilterExpression: '#st IN (:draft, :active)',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':tid': { S: tenantId },
          ':draft': { S: 'draft' },
          ':active': { S: 'active' },
        },
        Select: 'COUNT',
      })),
      // Count all sessions for this tenant
      dynamo.send(new QueryCommand({
        TableName: process.env.SESSIONS_TABLE,
        KeyConditionExpression: 'tenantId = :tid',
        ExpressionAttributeValues: { ':tid': { S: tenantId } },
        Select: 'COUNT',
      })),
    ])

    const records = batchResult.Responses?.[process.env.TENANTS_TABLE] ?? []
    const tenantItem = records.find(r => r.tenantId?.S === tenantId)
    const systemItem = records.find(r => r.tenantId?.S === 'SYSTEM')

    if (!tenantItem) {
      log('warn', 'GetSettings: tenant not found', { requestId, tenantId })
      return errorResponse(404, 'Tenant not found', {}, origin)
    }

    const tenant = unmarshal(tenantItem)
    const systemRecord = systemItem ? unmarshal(systemItem) : null
    const enrichedFeatures = resolveAllFeatures(tenant, systemRecord)
    const itemCount = itemsResult.Count ?? 0
    const sessionCount = sessionsResult.Count ?? 0

    return createResponse(200, {
      data: {
        tenantId: tenant.tenantId,
        displayName: tenant.displayName ?? null,
        email: tenant.email ?? null,
        tier: tenant.tier ?? 'free',
        features: tenant.features ?? {},
        enrichedFeatures,
        usage: { itemCount, sessionCount },
        onboardingComplete: tenant.onboardingComplete ?? false,
        preferences: tenant.preferences ?? {},
        termsAcceptedVersion: tenant.termsAcceptedVersion ?? null,
      },
    }, {}, origin)
  } catch (err) {
    log('error', 'GetSettings: unexpected error', { requestId, tenantId, errorName: err.name })
    return errorResponse(500, 'Failed to retrieve settings', {}, origin)
  }
}
