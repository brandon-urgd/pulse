// ur/gd pulse — Update Settings Lambda
// PUT /api/manage/settings → updates displayName and/or preferences.theme

import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

// Fail-fast env var validation
requireEnv(['TENANTS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

const VALID_THEMES = new Set(['light', 'dark', 'system'])

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId

  if (!tenantId) {
    log('warn', 'UpdateSettings: missing tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return errorResponse(400, 'Invalid request body', {}, origin)
  }

  const { displayName, preferences, termsAcceptedVersion, termsAcceptedAt } = body

  // Validate theme if provided
  if (preferences?.theme !== undefined && !VALID_THEMES.has(preferences.theme)) {
    return errorResponse(400, `theme must be one of: ${[...VALID_THEMES].join(', ')}`, {}, origin)
  }

  // Build update expression dynamically
  const expressionParts = ['#updatedAt = :updatedAt']
  const expressionNames = { '#updatedAt': 'updatedAt' }
  const expressionValues = { ':updatedAt': { S: new Date().toISOString() } }

  if (displayName !== undefined) {
    expressionParts.push('#displayName = :displayName')
    expressionNames['#displayName'] = 'displayName'
    expressionValues[':displayName'] = { S: String(displayName).trim().slice(0, 255) }
  }

  if (preferences?.theme !== undefined) {
    expressionParts.push('#preferences.#theme = :theme')
    expressionNames['#preferences'] = 'preferences'
    expressionNames['#theme'] = 'theme'
    expressionValues[':theme'] = { S: preferences.theme }
  }

  if (typeof termsAcceptedVersion === 'string') {
    expressionParts.push('#termsAcceptedVersion = :termsAcceptedVersion')
    expressionNames['#termsAcceptedVersion'] = 'termsAcceptedVersion'
    expressionValues[':termsAcceptedVersion'] = { S: termsAcceptedVersion }
  }

  if (typeof termsAcceptedAt === 'string') {
    expressionParts.push('#termsAcceptedAt = :termsAcceptedAt')
    expressionNames['#termsAcceptedAt'] = 'termsAcceptedAt'
    expressionValues[':termsAcceptedAt'] = { S: termsAcceptedAt }
  }

  log('info', 'UpdateSettings: updating tenant', { requestId, tenantId })

  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
    }))

    log('info', 'UpdateSettings: updated successfully', { requestId, tenantId })

    return createResponse(200, { message: 'Settings updated' }, {}, origin)
  } catch (err) {
    log('error', 'UpdateSettings: unexpected error', { requestId, tenantId, errorName: err.name })
    return errorResponse(500, 'Failed to update settings', {}, origin)
  }
}
