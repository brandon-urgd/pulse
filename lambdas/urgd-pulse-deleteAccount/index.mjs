// ur/gd pulse — Delete Account Lambda
// DELETE /api/manage/account → deletes tenant record, items, sessions, and Cognito user

import { DynamoDBClient, GetItemCommand, DeleteItemCommand, QueryCommand, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb'
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['TENANTS_TABLE', 'ITEMS_TABLE', 'SESSIONS_TABLE', 'USER_POOL_ID', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-west-2' })

/**
 * Delete all items in a query result set using BatchWriteItem (25 items per batch).
 */
async function batchDelete(tableName, keys) {
  if (!keys.length) return
  for (let i = 0; i < keys.length; i += 25) {
    const batch = keys.slice(i, i + 25).map(key => ({ DeleteRequest: { Key: key } }))
    await dynamo.send(new BatchWriteItemCommand({
      RequestItems: { [tableName]: batch },
    }))
  }
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const cognitoUsername = event?.requestContext?.authorizer?.username

  if (!tenantId) {
    log('warn', 'DeleteAccount: missing tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  log('info', 'DeleteAccount: starting account deletion', { requestId, tenantId })

  try {
    // 1. Verify tenant exists
    const tenantResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
    }))

    if (!tenantResult.Item) {
      log('warn', 'DeleteAccount: tenant not found', { requestId, tenantId })
      return errorResponse(404, 'Tenant not found', {}, origin)
    }

    // 2. Delete all sessions for this tenant
    let sessionLastKey
    const sessionKeys = []
    do {
      const result = await dynamo.send(new QueryCommand({
        TableName: process.env.SESSIONS_TABLE,
        KeyConditionExpression: 'tenantId = :tid',
        ExpressionAttributeValues: { ':tid': { S: tenantId } },
        ProjectionExpression: 'tenantId, sessionId',
        ExclusiveStartKey: sessionLastKey,
      }))
      for (const item of result.Items ?? []) {
        sessionKeys.push({ tenantId: item.tenantId, sessionId: item.sessionId })
      }
      sessionLastKey = result.LastEvaluatedKey
    } while (sessionLastKey)

    await batchDelete(process.env.SESSIONS_TABLE, sessionKeys)
    log('info', 'DeleteAccount: sessions deleted', { requestId, tenantId, count: sessionKeys.length })

    // 3. Delete all items for this tenant
    let itemLastKey
    const itemKeys = []
    do {
      const result = await dynamo.send(new QueryCommand({
        TableName: process.env.ITEMS_TABLE,
        KeyConditionExpression: 'tenantId = :tid',
        ExpressionAttributeValues: { ':tid': { S: tenantId } },
        ProjectionExpression: 'tenantId, itemId',
        ExclusiveStartKey: itemLastKey,
      }))
      for (const item of result.Items ?? []) {
        itemKeys.push({ tenantId: item.tenantId, itemId: item.itemId })
      }
      itemLastKey = result.LastEvaluatedKey
    } while (itemLastKey)

    await batchDelete(process.env.ITEMS_TABLE, itemKeys)
    log('info', 'DeleteAccount: items deleted', { requestId, tenantId, count: itemKeys.length })

    // 4. Delete tenant record
    await dynamo.send(new DeleteItemCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
    }))
    log('info', 'DeleteAccount: tenant record deleted', { requestId, tenantId })

    // 5. Delete Cognito user (best-effort — don't fail the whole operation if this errors)
    if (cognitoUsername) {
      try {
        await cognito.send(new AdminDeleteUserCommand({
          UserPoolId: process.env.USER_POOL_ID,
          Username: cognitoUsername,
        }))
        log('info', 'DeleteAccount: Cognito user deleted', { requestId, tenantId })
      } catch (cognitoErr) {
        log('error', 'DeleteAccount: Cognito user deletion failed (data already deleted)', { requestId, tenantId, errorName: cognitoErr.name })
      }
    }

    return createResponse(200, { message: 'Account deleted' }, {}, origin)
  } catch (err) {
    log('error', 'DeleteAccount: unexpected error', { requestId, tenantId, errorName: err.name })
    return errorResponse(500, 'Failed to delete account', {}, origin)
  }
}
