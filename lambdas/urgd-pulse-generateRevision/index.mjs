// ur/gd pulse — Generate Revision Lambda (Kick-Off)
// POST /api/manage/items/{itemId}/revise
//
// Validates inputs (feature flag, pulse check, accepted/revised decisions),
// writes a 'generating' revision record to DynamoDB Revisions table,
// invokes processRevision Lambda asynchronously, returns HTTP 202.
// Follows the runPulseCheck → processPulseCheck async pattern.

import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { createResponse, errorResponse, log, requireEnv, unmarshalFeatures } from './shared/utils.mjs'
import { resolveFeature } from './shared/features.mjs'
import { randomUUID } from 'crypto'

requireEnv([
  'PULSE_CHECKS_TABLE', 'ITEMS_TABLE', 'TENANTS_TABLE',
  'REVISIONS_TABLE', 'PROCESS_FUNCTION_NAME', 'CORS_ALLOWED_ORIGINS',
])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) return errorResponse(401, 'Unauthorized', {}, origin)
  if (!itemId) return errorResponse(400, 'itemId is required', {}, origin)

  try {
    // 1. Check itemRevisionLoop feature flag
    const [tenantResult, systemResult] = await Promise.all([
      dynamo.send(new GetItemCommand({
        TableName: process.env.TENANTS_TABLE,
        Key: { tenantId: { S: tenantId } },
      })),
      dynamo.send(new GetItemCommand({
        TableName: process.env.TENANTS_TABLE,
        Key: { tenantId: { S: 'SYSTEM' } },
      })),
    ])

    const tenantRecord = tenantResult.Item ? {
      tier: tenantResult.Item.tier?.S ?? 'free',
      features: unmarshalFeatures(tenantResult.Item.features?.M),
      serviceFlags: unmarshalFeatures(tenantResult.Item.serviceFlags?.M),
    } : { tier: 'free', features: {}, serviceFlags: {} }
    const systemRecord = systemResult.Item ? {
      serviceFlags: unmarshalFeatures(systemResult.Item.serviceFlags?.M),
    } : null

    const revisionResult = resolveFeature(tenantRecord, 'itemRevisionLoop', systemRecord)
    if (!revisionResult.allowed) {
      log('info', 'GenerateRevision: itemRevisionLoop flag is off', { requestId, tenantId, itemId, reason: revisionResult.reason })
      return errorResponse(
        revisionResult.reason === 'maintenance' ? 503 : 403,
        revisionResult.reason === 'maintenance' ? 'Feature under maintenance' : 'Item revision is not enabled for your account',
        {}, origin
      )
    }

    // 2. Get pulse check — must exist and be complete
    const pulseCheckResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.PULSE_CHECKS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
    }))

    if (!pulseCheckResult.Item || pulseCheckResult.Item.status?.S !== 'complete') {
      log('info', 'GenerateRevision: no completed pulse check', { requestId, tenantId, itemId })
      return errorResponse(409, 'Pulse check must be completed before revising.', {}, origin)
    }

    const pulseCheck = pulseCheckResult.Item

    // 3. Extract decisions — must have at least one accepted/revised
    const decisionsMap = pulseCheck.decisions?.M ?? {}
    const proposedRevisions = pulseCheck.proposedRevisions?.L ?? []

    const acceptedOrRevised = proposedRevisions.filter(pr => {
      const revisionId = pr.M?.revisionId?.S
      const decision = revisionId ? decisionsMap[revisionId]?.M : null
      return decision && (decision.action?.S === 'Accept' || decision.action?.S === 'Revise')
    })

    if (acceptedOrRevised.length === 0) {
      log('info', 'GenerateRevision: no accepted/revised decisions', { requestId, tenantId, itemId })
      return errorResponse(409, 'No accepted or revised decisions found. Accept or revise at least one feedback point before generating a revision.', {}, origin)
    }

    // 4. Generate revision record with status: 'generating'
    const revisionId = randomUUID()
    const startedAt = new Date().toISOString()

    await dynamo.send(new PutItemCommand({
      TableName: process.env.REVISIONS_TABLE,
      Item: {
        tenantId: { S: tenantId },
        revisionId: { S: revisionId },
        itemId: { S: itemId },
        status: { S: 'generating' },
        createdAt: { S: startedAt },
        decisionsApplied: { N: String(acceptedOrRevised.length) },
      },
    }))

    // 5. Invoke processRevision Lambda asynchronously
    try {
      await lambda.send(new InvokeCommand({
        FunctionName: process.env.PROCESS_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: JSON.stringify({ tenantId, itemId, revisionId, startedAt }),
      }))
    } catch (invokeErr) {
      log('error', 'GenerateRevision: async invocation failed', { requestId, tenantId, itemId, revisionId, errorName: invokeErr.name })
      // Mark revision as failed
      await dynamo.send(new UpdateItemCommand({
        TableName: process.env.REVISIONS_TABLE,
        Key: { tenantId: { S: tenantId }, revisionId: { S: revisionId } },
        UpdateExpression: 'SET #status = :failed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':failed': { S: 'failed' } },
      })).catch(() => {})
      return errorResponse(500, 'Failed to start revision generation', {}, origin)
    }

    log('info', 'GenerateRevision: dispatched to processRevision', { requestId, tenantId, itemId, revisionId })

    return createResponse(202, {
      data: {
        revisionId,
        status: 'generating',
      },
    }, {}, origin)
  } catch (err) {
    log('error', 'GenerateRevision: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to generate revision', {}, origin)
  }
}
