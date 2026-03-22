// ur/gd pulse — Session Token Authorizer
// Looks up Bearer token in DynamoDB sessions table, returns IAM Allow/Deny

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { log } from './shared/utils.mjs'

// Fail-fast env var validation
const REQUIRED_ENV = ['SESSIONS_TABLE']
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`)
  }
}

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

const generatePolicy = (principalId, effect, resource, context = {}) => ({
  principalId,
  policyDocument: {
    Version: '2012-10-17',
    Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }],
  },
  context,
})

export const handler = async (event) => {
  const token = (event.authorizationToken || '').replace(/^Bearer\s+/i, '')

  if (!token) {
    log('warn', 'SessionAuth: missing token')
    return generatePolicy('anonymous', 'Deny', event.methodArn)
  }

  try {
    // Session records are keyed by tenantId (PK) + sessionId (SK)
    // The Bearer token IS the sessionId — we scan by pulseCode-index or use a token-index
    // For S0: token format is "{tenantId}:{sessionId}"
    const [tenantId, sessionId] = token.split(':')
    if (!tenantId || !sessionId) throw new Error('Invalid token format')

    const result = await dynamo.send(new GetItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        sessionId: { S: sessionId },
      },
    }))

    if (!result.Item) throw new Error('Session not found')

    // Check expiry if present
    const expiresAt = result.Item.expiresAt?.N
    if (expiresAt && Date.now() / 1000 > Number(expiresAt)) {
      throw new Error('Session expired')
    }

    // Extract preview flag — passed via authorizer context so downstream Lambdas
    // can short-circuit writes for preview sessions
    const isPreview = result.Item.preview?.BOOL === true

    log('info', 'SessionAuth: allowed', { sessionId })

    return generatePolicy(sessionId, 'Allow', event.methodArn, {
      sessionId,
      tenantId,
      preview: isPreview ? 'true' : 'false',
    })
  } catch (err) {
    log('warn', 'SessionAuth: denied', { reason: err.message })
    return generatePolicy('anonymous', 'Deny', event.methodArn)
  }
}
