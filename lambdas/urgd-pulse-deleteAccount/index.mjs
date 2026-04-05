// ur/gd pulse — Delete Account Lambda
// DELETE /api/manage/account
//
// Validates confirmEmail matches tenant's email.
// Deletes all records across all 6 DynamoDB tables for tenantId.
// Deletes all S3 objects under pulse/{tenantId}/.
// Calls cognito-idp:AdminDeleteUser.
// Publishes completion alert to ALERTS_TOPIC_ARN.

import {
  DynamoDBClient,
  GetItemCommand,
  DeleteItemCommand,
  QueryCommand,
  BatchWriteItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb'
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv([
  'TENANTS_TABLE', 'ITEMS_TABLE', 'SESSIONS_TABLE',
  'TRANSCRIPTS_TABLE', 'REPORTS_TABLE', 'PULSE_CHECKS_TABLE',
  'DATA_BUCKET', 'USER_POOL_ID', 'ALERTS_TOPIC_ARN', 'CORS_ALLOWED_ORIGINS',
])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })
const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-west-2' })
const sns = new SNSClient({ region: process.env.AWS_REGION || 'us-west-2' })
const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-west-2' })

/**
 * Delete all items in a key list using BatchWriteItem (25 items per batch).
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

/**
 * Query all records for a tenant from a table with tenantId PK.
 * Returns array of DynamoDB key objects.
 */
async function queryAllByTenant(tableName, skName, tenantId) {
  const keys = []
  let lastKey
  do {
    const result = await dynamo.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'tenantId = :tid',
      ExpressionAttributeValues: { ':tid': { S: tenantId } },
      ProjectionExpression: `tenantId, ${skName}`,
      ExclusiveStartKey: lastKey,
    }))
    for (const item of result.Items ?? []) {
      keys.push({ tenantId: item.tenantId, [skName]: item[skName] })
    }
    lastKey = result.LastEvaluatedKey
  } while (lastKey)
  return keys
}

/**
 * Delete all S3 objects under a given prefix (paginated).
 */
async function deleteS3Prefix(bucket, prefix) {
  let totalDeleted = 0
  let continuationToken

  do {
    const listResult = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    }))

    const objects = listResult.Contents ?? []
    if (objects.length > 0) {
      // DeleteObjects accepts up to 1000 keys per call
      for (let i = 0; i < objects.length; i += 1000) {
        const batch = objects.slice(i, i + 1000).map(o => ({ Key: o.Key }))
        await s3.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch, Quiet: true },
        }))
        totalDeleted += batch.length
      }
    }

    continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined
  } while (continuationToken)

  return totalDeleted
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

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return errorResponse(400, 'Invalid request body', {}, origin)
  }

  const { confirmEmail } = body

  if (!confirmEmail || typeof confirmEmail !== 'string') {
    return errorResponse(400, 'confirmEmail is required', {}, origin)
  }

  log('info', 'DeleteAccount: starting account deletion', { requestId, tenantId })

  try {
    // 1. Verify tenant exists and validate confirmEmail
    const tenantResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
    }))

    if (!tenantResult.Item) {
      log('warn', 'DeleteAccount: tenant not found', { requestId, tenantId })
      return errorResponse(404, 'Tenant not found', {}, origin)
    }

    const tenantEmail = tenantResult.Item.email?.S ?? ''

    // 2. Validate email confirmation — must match exactly
    if (confirmEmail.trim().toLowerCase() !== tenantEmail.trim().toLowerCase()) {
      log('warn', 'DeleteAccount: email confirmation mismatch', { requestId, tenantId })
      return errorResponse(400, 'Email confirmation does not match', {}, origin)
    }

    // Stripe cleanup — cancel subscriptions and delete customer BEFORE data deletion
    const stripeCustomerId = tenantResult.Item?.stripeCustomerId?.S
    if (stripeCustomerId && process.env.STRIPE_SECRET_KEY_PARAM) {
      try {
        const ssmResult = await ssm.send(new GetParameterCommand({
          Name: process.env.STRIPE_SECRET_KEY_PARAM,
          WithDecryption: true,
        }))
        const { default: Stripe } = await import('stripe')
        const stripe = new Stripe(ssmResult.Parameter.Value)

        // Cancel all active subscriptions
        const subscriptions = await stripe.subscriptions.list({
          customer: stripeCustomerId,
          status: 'active',
        })
        for (const sub of subscriptions.data) {
          await stripe.subscriptions.cancel(sub.id)
          log('info', 'DeleteAccount: cancelled Stripe subscription', { requestId, tenantId, subscriptionId: sub.id })
        }

        // Delete the Stripe Customer
        await stripe.customers.del(stripeCustomerId)
        log('info', 'DeleteAccount: deleted Stripe Customer', { requestId, tenantId, stripeCustomerId })
      } catch (stripeErr) {
        log('warn', 'DeleteAccount: Stripe cleanup failed, proceeding with data deletion', {
          requestId, tenantId, stripeCustomerId, errorName: stripeErr.name,
        })
      }
    }

    // 3. Delete all sessions for this tenant
    const sessionKeys = await queryAllByTenant(process.env.SESSIONS_TABLE, 'sessionId', tenantId)
    await batchDelete(process.env.SESSIONS_TABLE, sessionKeys)
    log('info', 'DeleteAccount: sessions deleted', { requestId, tenantId, count: sessionKeys.length })

    // 4. Delete all items for this tenant
    const itemKeys = await queryAllByTenant(process.env.ITEMS_TABLE, 'itemId', tenantId)
    await batchDelete(process.env.ITEMS_TABLE, itemKeys)
    log('info', 'DeleteAccount: items deleted', { requestId, tenantId, count: itemKeys.length })

    // 5. Delete all reports for this tenant
    const reportKeys = await queryAllByTenant(process.env.REPORTS_TABLE, 'sessionId', tenantId)
    await batchDelete(process.env.REPORTS_TABLE, reportKeys)
    log('info', 'DeleteAccount: reports deleted', { requestId, tenantId, count: reportKeys.length })

    // 6. Delete all pulse checks for this tenant
    const pulseCheckKeys = await queryAllByTenant(process.env.PULSE_CHECKS_TABLE, 'itemId', tenantId)
    await batchDelete(process.env.PULSE_CHECKS_TABLE, pulseCheckKeys)
    log('info', 'DeleteAccount: pulse checks deleted', { requestId, tenantId, count: pulseCheckKeys.length })

    // 7. Delete transcripts — transcripts table uses sessionId as PK (not tenantId)
    // We need to scan for all sessionIds that belonged to this tenant's sessions
    // We already have the session keys — use those sessionIds to query transcripts
    const transcriptKeys = []
    for (const sk of sessionKeys) {
      const sessionId = sk.sessionId?.S
      if (!sessionId) continue
      let lastKey
      do {
        const result = await dynamo.send(new QueryCommand({
          TableName: process.env.TRANSCRIPTS_TABLE,
          KeyConditionExpression: 'sessionId = :sid',
          ExpressionAttributeValues: { ':sid': { S: sessionId } },
          ProjectionExpression: 'sessionId, messageId',
          ExclusiveStartKey: lastKey,
        }))
        for (const item of result.Items ?? []) {
          transcriptKeys.push({ sessionId: item.sessionId, messageId: item.messageId })
        }
        lastKey = result.LastEvaluatedKey
      } while (lastKey)
    }
    await batchDelete(process.env.TRANSCRIPTS_TABLE, transcriptKeys)
    log('info', 'DeleteAccount: transcripts deleted', { requestId, tenantId, count: transcriptKeys.length })

    // 8. Delete tenant record
    await dynamo.send(new DeleteItemCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
    }))
    log('info', 'DeleteAccount: tenant record deleted', { requestId, tenantId })

    // 9. Delete all S3 objects under pulse/{tenantId}/
    const s3Prefix = `pulse/${tenantId}/`
    const s3Deleted = await deleteS3Prefix(process.env.DATA_BUCKET, s3Prefix)
    log('info', 'DeleteAccount: S3 objects deleted', { requestId, tenantId, count: s3Deleted })

    // 10. Delete Cognito user (best-effort — don't fail the whole operation if this errors)
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

    // 11. Publish completion alert to SNS
    try {
      await sns.send(new PublishCommand({
        TopicArn: process.env.ALERTS_TOPIC_ARN,
        Subject: 'Pulse: Account deleted',
        Message: JSON.stringify({
          alert: 'account_deleted',
          tenantId,
          sessionsDeleted: sessionKeys.length,
          itemsDeleted: itemKeys.length,
          s3ObjectsDeleted: s3Deleted,
          timestamp: new Date().toISOString(),
        }),
      }))
    } catch (snsErr) {
      log('warn', 'DeleteAccount: SNS alert publish failed', { requestId, tenantId, errorName: snsErr.name })
    }

    return createResponse(200, { message: 'Account deleted' }, {}, origin)
  } catch (err) {
    log('error', 'DeleteAccount: unexpected error', { requestId, tenantId, errorName: err.name })
    return errorResponse(500, 'Failed to delete account', {}, origin)
  }
}
