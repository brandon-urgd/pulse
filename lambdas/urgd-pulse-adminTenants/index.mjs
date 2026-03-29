// ur/gd pulse — Admin Tenants Lambda
// PATCH /api/admin/tenants/{tenantId} → modify tenant tier, feature overrides, service flags

import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { VALID_TIERS, VALID_FLAGS } from './shared/tiers.mjs'

requireEnv(['TENANTS_TABLE', 'CORS_ALLOWED_ORIGINS'])

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
  const tenantId = event?.pathParameters?.tenantId

  // Validate caller is authenticated (admin operating on OTHER tenants)
  const callerTenantId = event?.requestContext?.authorizer?.tenantId
  if (!callerTenantId) {
    log('warn', 'AdminTenants: missing tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!tenantId) {
    log('warn', 'AdminTenants: missing tenantId path parameter', { requestId })
    return errorResponse(400, 'Missing tenantId', {}, origin)
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return errorResponse(400, 'Invalid request body', {}, origin)
  }

  const { tier, features, serviceFlags } = body

  // --- Validation ---

  // Validate tier
  if (tier !== undefined && !VALID_TIERS.includes(tier)) {
    log('warn', 'AdminTenants: invalid tier', { requestId, tenantId, tier })
    return errorResponse(400, 'Invalid tier', {}, origin)
  }

  // Validate feature flags
  if (features !== undefined) {
    if (typeof features !== 'object' || features === null || Array.isArray(features)) {
      return errorResponse(400, 'features must be an object', {}, origin)
    }
    for (const flagName of Object.keys(features)) {
      if (!VALID_FLAGS.includes(flagName)) {
        log('warn', 'AdminTenants: invalid feature flag', { requestId, tenantId, flagName })
        return errorResponse(400, `Invalid feature flag: ${flagName}`, {}, origin)
      }
    }
  }

  // SYSTEM record protection
  if (tenantId === 'SYSTEM' && (tier !== undefined || features !== undefined)) {
    log('warn', 'AdminTenants: attempted tier/features modification on SYSTEM record', { requestId })
    return errorResponse(400, 'Cannot modify tier/features on SYSTEM record', {}, origin)
  }

  try {
    // Fetch target tenant record
    const getResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
    }))

    if (!getResult.Item) {
      log('warn', 'AdminTenants: tenant not found', { requestId, tenantId })
      return errorResponse(404, 'Tenant not found', {}, origin)
    }

    // Build dynamic UpdateExpression
    const now = new Date().toISOString()
    const expressionParts = []
    const expressionNames = {}
    const expressionValues = { ':now': { S: now } }
    const changes = []

    // Always update updatedAt
    expressionParts.push('#updatedAt = :now')
    expressionNames['#updatedAt'] = 'updatedAt'

    // Tier update
    if (tier !== undefined) {
      expressionParts.push('#tier = :tier')
      expressionNames['#tier'] = 'tier'
      expressionValues[':tier'] = { S: tier }
      changes.push('tier')
    }

    // Features merge (additive — don't replace the whole map)
    if (features !== undefined) {
      for (const [flagName, flagValue] of Object.entries(features)) {
        const safeKey = `:feat_${flagName}`
        expressionParts.push(`#features.#feat_${flagName} = ${safeKey}`)
        expressionNames['#features'] = 'features'
        expressionNames[`#feat_${flagName}`] = flagName

        if (typeof flagValue === 'boolean') {
          expressionValues[safeKey] = { BOOL: flagValue }
        } else if (typeof flagValue === 'number') {
          expressionValues[safeKey] = { N: String(flagValue) }
        } else if (typeof flagValue === 'string') {
          expressionValues[safeKey] = { S: flagValue }
        }
      }
      changes.push('features')
    }

    // ServiceFlags update (full replace)
    if (serviceFlags !== undefined) {
      expressionParts.push('#serviceFlags = :sf')
      expressionNames['#serviceFlags'] = 'serviceFlags'
      expressionValues[':sf'] = marshalMap(serviceFlags)
      changes.push('serviceFlags')
    }

    const updateExpression = 'SET ' + expressionParts.join(', ')

    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
      ReturnValues: 'ALL_NEW',
    }))

    // Re-fetch to return clean data
    const updatedResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
    }))

    const updated = unmarshal(updatedResult.Item)

    log('info', 'AdminTenants: tenant updated', { requestId, tenantId, changes })

    return createResponse(200, {
      data: {
        tenantId: updated.tenantId,
        tier: updated.tier ?? null,
        features: updated.features ?? {},
        serviceFlags: updated.serviceFlags ?? {},
      },
    }, {}, origin)
  } catch (err) {
    log('error', 'AdminTenants: unexpected error', { requestId, tenantId, errorName: err.name })
    return errorResponse(500, 'Failed to update tenant', {}, origin)
  }
}

/**
 * Marshal a plain JS object into a DynamoDB attribute map.
 */
function marshalMap(obj) {
  if (obj === null || obj === undefined) return { M: {} }
  if (typeof obj !== 'object' || Array.isArray(obj)) return { M: {} }

  const m = {}
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      m[key] = { S: value }
    } else if (typeof value === 'number') {
      m[key] = { N: String(value) }
    } else if (typeof value === 'boolean') {
      m[key] = { BOOL: value }
    } else if (value === null) {
      m[key] = { NULL: true }
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      m[key] = marshalMap(value)
    }
  }
  return { M: m }
}
