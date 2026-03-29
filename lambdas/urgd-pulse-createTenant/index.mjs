// ur/gd pulse — Create Tenant Lambda
// Called internally after successful registration to create the tenant record

import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { getTierDefaults } from './shared/tiers.mjs'
import { randomUUID } from 'crypto'

// Fail-fast env var validation
requireEnv(['TENANTS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

const FREE_TIER_USAGE = {
  itemCount: 0,
  sessionCount: 0,
}

export const handler = async (event) => {
  // ── Cognito PostConfirmation trigger ───────────────────────────────────────
  // When invoked by Cognito, event.userName is the sub and there is no body.
  // Must return the event object back to Cognito.
  const isCognitoTrigger = !!event.triggerSource

  const tenantId = isCognitoTrigger
    ? event.userName
    : randomUUID()

  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const now = new Date().toISOString()

  log('info', 'CreateTenant: creating tenant record', { requestId, tenantId, isCognitoTrigger })

  try {
    const defaults = getTierDefaults('free')
    // Convert to DynamoDB attribute map
    const featuresMap = {}
    for (const [key, value] of Object.entries(defaults)) {
      if (typeof value === 'boolean') {
        featuresMap[key] = { BOOL: value }
      } else if (typeof value === 'number') {
        featuresMap[key] = { N: String(value) }
      }
    }

    await dynamo.send(new PutItemCommand({
      TableName: process.env.TENANTS_TABLE,
      ConditionExpression: 'attribute_not_exists(tenantId)',
      Item: {
        tenantId: { S: tenantId },
        tier: { S: 'free' },
        onboardingComplete: { BOOL: false },
        createdAt: { S: now },
        updatedAt: { S: now },
        features: { M: featuresMap },
        usage: {
          M: {
            itemCount: { N: String(FREE_TIER_USAGE.itemCount) },
            sessionCount: { N: String(FREE_TIER_USAGE.sessionCount) },
          },
        },
      },
    }))

    log('info', 'CreateTenant: tenant created', { requestId, tenantId })
  } catch (err) {
    // ConditionalCheckFailedException means tenant already exists — idempotent, not an error
    if (err.name !== 'ConditionalCheckFailedException') {
      log('error', 'CreateTenant: failed to create tenant', { requestId, tenantId, errorName: err.name })
      if (!isCognitoTrigger) return errorResponse(500, 'Failed to create tenant', {}, origin)
      throw err // re-throw so Cognito blocks confirmation on hard failure
    }
    log('info', 'CreateTenant: tenant already exists, skipping', { requestId, tenantId })
  }

  // Cognito triggers must return the event
  if (isCognitoTrigger) return event

  return createResponse(201, {
    tenantId,
    tier: 'free',
    onboardingComplete: false,
    features: getTierDefaults('free'),
    usage: FREE_TIER_USAGE,
    createdAt: now,
    updatedAt: now,
  }, {}, origin)
}
