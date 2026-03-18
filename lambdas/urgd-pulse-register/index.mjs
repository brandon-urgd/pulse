// ur/gd pulse — Register Lambda
// POST /api/auth/register → creates Cognito user + triggers createTenant

import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand } from '@aws-sdk/client-cognito-identity-provider'
import { createResponse, errorResponse, log, requireEnv, isValidEmail } from '../shared/utils.mjs'

// Fail-fast env var validation
requireEnv(['USER_POOL_ID', 'USER_POOL_CLIENT_ID', 'PUBLIC_SIGNUP', 'CORS_ALLOWED_ORIGINS'])

const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId

  // Check PUBLIC_SIGNUP gate before doing anything else
  if (process.env.PUBLIC_SIGNUP !== 'true') {
    log('warn', 'Register: public signup disabled', { requestId })
    return errorResponse(403, 'Public sign-up is not enabled', {}, origin)
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return errorResponse(400, 'Invalid request body', {}, origin)
  }

  const { name, email, password } = body

  // Validate required fields
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return errorResponse(400, 'name is required', {}, origin)
  }
  if (!email || !isValidEmail(email)) {
    return errorResponse(400, 'A valid email is required', {}, origin)
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return errorResponse(400, 'password must be at least 8 characters', {}, origin)
  }

  log('info', 'Register: creating user', { requestId })

  try {
    // Create user in Cognito (suppress welcome email, set permanent password)
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: process.env.USER_POOL_ID,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: name },
      ],
      MessageAction: 'SUPPRESS',
    }))

    // Set permanent password immediately
    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: process.env.USER_POOL_ID,
      Username: email,
      Password: password,
      Permanent: true,
    }))

    log('info', 'Register: user created successfully', { requestId })

    return createResponse(201, { message: 'User registered successfully' }, {}, origin)
  } catch (err) {
    if (err.name === 'UsernameExistsException') {
      log('warn', 'Register: duplicate email', { requestId })
      return errorResponse(409, 'An account with this email already exists', {}, origin)
    }
    log('error', 'Register: unexpected error', { requestId, errorName: err.name })
    return errorResponse(500, 'Registration failed', {}, origin)
  }
}
