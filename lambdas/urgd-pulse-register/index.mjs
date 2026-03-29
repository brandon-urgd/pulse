// ur/gd pulse — Register Lambda
// POST /api/auth/register → creates Cognito user + triggers createTenant

import { CognitoIdentityProviderClient, AdminCreateUserCommand } from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv, isValidEmail } from './shared/utils.mjs'
import { getTierDefaults } from './shared/tiers.mjs'

// Fail-fast env var validation
requireEnv(['USER_POOL_ID', 'USER_POOL_CLIENT_ID', 'CORS_ALLOWED_ORIGINS', 'TENANTS_TABLE'])

const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-west-2' })
const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId

  // Check SYSTEM record for publicSignup gate
  try {
    const systemResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId: { S: 'SYSTEM' } },
    }))
    const publicSignupStatus = systemResult.Item?.serviceFlags?.M?.publicSignup?.M?.status?.S
    if (publicSignupStatus === 'maintenance') {
      log('warn', 'Register: public signup disabled via SYSTEM record', { requestId })
      return errorResponse(503, 'Public sign-up is not available', {}, origin)
    }
  } catch (err) {
    // Fail-open: if SYSTEM record can't be read, allow registration
    log('warn', 'Register: failed to read SYSTEM record, proceeding with registration', { requestId, errorName: err.name })
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return errorResponse(400, 'Invalid request body', {}, origin)
  }

  const { name, email } = body

  // Validate required fields
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return errorResponse(400, 'name is required', {}, origin)
  }
  if (!email || !isValidEmail(email)) {
    return errorResponse(400, 'A valid email is required', {}, origin)
  }

  log('info', 'Register: creating user', { requestId })

  try {
    // Create user in Cognito — Cognito generates a secure temporary password and
    // emails it automatically. User must change password on first login.
    // We do NOT accept or store a user-supplied password here.
    const result = await cognito.send(new AdminCreateUserCommand({
      UserPoolId: process.env.USER_POOL_ID,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: name },
      ],
      // No TemporaryPassword — Cognito generates a secure one
      // No MessageAction: SUPPRESS — let Cognito send the welcome email
    }))

    // AdminCreateUser does not trigger PostConfirmation — create tenant record inline
    const tenantId = result.User.Attributes.find(a => a.Name === 'sub')?.Value
    if (tenantId) {
      const now = new Date().toISOString()
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
          email: { S: email },
          displayName: { S: name.trim() },
          tier: { S: 'free' },
          onboardingComplete: { BOOL: false },
          createdAt: { S: now },
          updatedAt: { S: now },
          features: { M: featuresMap },
          usage: {
            M: {
              itemCount: { N: '0' },
              sessionCount: { N: '0' },
            },
          },
        },
      }))
      log('info', 'Register: tenant record created', { requestId, tenantId })
    }

    log('info', 'Register: user created, verification email sent', { requestId })

    return createResponse(201, { message: 'User registered successfully. Check your email for a verification code.' }, {}, origin)
  } catch (err) {
    if (err.name === 'UsernameExistsException') {
      log('warn', 'Register: duplicate email', { requestId })
      return errorResponse(409, 'An account with this email already exists', {}, origin)
    }
    log('error', 'Register: unexpected error', { requestId, errorName: err.name })
    return errorResponse(500, 'Registration failed', {}, origin)
  }
}
