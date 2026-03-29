// ur/gd pulse — Public Config Lambda
// GET /api/public/config → returns SYSTEM record signup state (no auth required)

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['TENANTS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId

  log('info', 'PublicConfig: fetching SYSTEM record', { requestId })

  try {
    const result = await dynamo.send(new GetItemCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId: { S: 'SYSTEM' } },
    }))

    // Check if SYSTEM record exists and has publicSignup in maintenance
    const publicSignupStatus = result.Item
      ?.serviceFlags?.M
      ?.publicSignup?.M
      ?.status?.S

    if (publicSignupStatus === 'maintenance') {
      log('info', 'PublicConfig: publicSignup is in maintenance', { requestId })
      return createResponse(200, {
        data: {
          publicSignup: { allowed: false, reason: 'maintenance' },
        },
      }, {}, origin)
    }

    // Fail-open: SYSTEM record missing, no publicSignup field, or status !== 'maintenance'
    log('info', 'PublicConfig: publicSignup is allowed', { requestId })
    return createResponse(200, {
      data: {
        publicSignup: { allowed: true, reason: 'allowed' },
      },
    }, {}, origin)
  } catch (err) {
    log('error', 'PublicConfig: unexpected error', { requestId, errorName: err.name })
    return errorResponse(500, 'Failed to retrieve config', {}, origin)
  }
}
