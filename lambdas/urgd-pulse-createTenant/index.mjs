// ur/gd pulse — Create Tenant Lambda
// Called internally after successful registration to create the tenant record

import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { randomUUID } from 'crypto'

// Fail-fast env var validation
requireEnv(['TENANTS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

const FREE_TIER_FEATURES = {
  publicSignUp: true,
  maxActiveItems: 1,
  maxSessionsPerItem: 5,
  sessionTimeLimitMinutes: 15,
  pulseCheckGroupMode: false,
  itemRevisionLoop: false,
  emailReminders: true,
}

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
    await dynamo.send(new PutItemCommand({
      TableName: process.env.TENANTS_TABLE,
      ConditionExpression: 'attribute_not_exists(tenantId)',
      Item: {
        tenantId: { S: tenantId },
        tier: { S: 'free' },
        onboardingComplete: { BOOL: false },
        createdAt: { S: now },
        updatedAt: { S: now },
        features: {
          M: {
            publicSignUp: { BOOL: FREE_TIER_FEATURES.publicSignUp },
            maxActiveItems: { N: String(FREE_TIER_FEATURES.maxActiveItems) },
            maxSessionsPerItem: { N: String(FREE_TIER_FEATURES.maxSessionsPerItem) },
            sessionTimeLimitMinutes: { N: String(FREE_TIER_FEATURES.sessionTimeLimitMinutes) },
            pulseCheckGroupMode: { BOOL: FREE_TIER_FEATURES.pulseCheckGroupMode },
            itemRevisionLoop: { BOOL: FREE_TIER_FEATURES.itemRevisionLoop },
            emailReminders: { BOOL: FREE_TIER_FEATURES.emailReminders },
          },
        },
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
    features: FREE_TIER_FEATURES,
    usage: FREE_TIER_USAGE,
    createdAt: now,
    updatedAt: now,
  }, {}, origin)
}
