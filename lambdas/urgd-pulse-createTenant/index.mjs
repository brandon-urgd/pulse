// ur/gd pulse — Create Tenant Lambda
// Called internally after successful registration to create the tenant record

import { DynamoDBClient, PutItemCommand, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { getTierDefaults } from './shared/tiers.mjs'
import { randomUUID } from 'crypto'
import { ulid } from 'ulid'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// Fail-fast env var validation
requireEnv(['TENANTS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })

// Load example session fixtures at module init (bundled with Lambda)
let exampleFixtures = null
try {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const raw = readFileSync(join(__dirname, 'example-session-fixtures.json'), 'utf-8')
  exampleFixtures = JSON.parse(raw)
} catch (err) {
  // Fixture file missing or malformed — seeding will be skipped
  console.warn('CreateTenant: failed to load example fixtures', err.message)
}

const FREE_TIER_USAGE = {
  itemCount: 0,
  sessionCount: 0,
}

/**
 * Seeds example data (item, session, transcript, report, pulse check) for a new tenant.
 * All records carry isExample: true. Failures are logged but do not block tenant creation.
 */
async function seedExampleData(tenantId) {
  if (!exampleFixtures) {
    log('warn', 'CreateTenant: example fixtures not loaded, skipping seeding', { tenantId })
    return
  }

  if (!process.env.ITEMS_TABLE || !process.env.SESSIONS_TABLE || !process.env.TRANSCRIPTS_TABLE || !process.env.REPORTS_TABLE || !process.env.PULSE_CHECKS_TABLE) {
    log('warn', 'CreateTenant: missing table env vars for seeding, skipping', { tenantId })
    return
  }

  const itemId = ulid()
  const sessionId = ulid()
  const now = new Date()
  const createdAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days ago
  const closedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString()  // 3 days ago
  const closeDate = closedAt
  const completedAt = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString() // 4 days ago
  const reportGeneratedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000 + 60000).toISOString()
  const pulseCheckGeneratedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000 + 120000).toISOString()

  const fix = exampleFixtures

  // 1. Write example item
  const itemRecord = {
    tenantId: { S: tenantId },
    itemId: { S: itemId },
    itemName: { S: fix.item.itemName },
    description: { S: fix.item.description },
    status: { S: fix.item.status },
    itemType: { S: fix.item.itemType },
    documentStatus: { S: fix.item.documentStatus },
    documentKey: { S: `pulse/${tenantId}/items/${itemId}/extracted.md` },
    closeDate: { S: closeDate },
    closedAt: { S: closedAt },
    createdAt: { S: createdAt },
    updatedAt: { S: closedAt },
    hasPulseCheck: { BOOL: true },
    isExample: { BOOL: true },
  }
  await dynamo.send(new PutItemCommand({ TableName: process.env.ITEMS_TABLE, Item: itemRecord }))
  log('info', 'CreateTenant: seeded example item', { tenantId, itemId })

  // 2. Write example session
  const sessionRecord = {
    tenantId: { S: tenantId },
    sessionId: { S: sessionId },
    itemId: { S: itemId },
    reviewerName: { S: fix.session.reviewerName },
    status: { S: fix.session.status },
    completedAt: { S: completedAt },
    createdAt: { S: createdAt },
    updatedAt: { S: completedAt },
    timeLimitMinutes: { N: String(fix.session.timeLimitMinutes) },
    totalSections: { N: String(fix.session.totalSections) },
    isExample: { BOOL: true },
  }
  await dynamo.send(new PutItemCommand({ TableName: process.env.SESSIONS_TABLE, Item: sessionRecord }))
  log('info', 'CreateTenant: seeded example session', { tenantId, sessionId })

  // 3. Write example transcript records via BatchWriteItem (max 25 per batch)
  const baseTimestamp = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000 - 20 * 60 * 1000) // 20 min before completedAt
  const transcriptPutRequests = fix.transcript.map((msg, idx) => ({
    PutRequest: {
      Item: {
        sessionId: { S: sessionId },
        messageId: { S: ulid() },
        role: { S: msg.role },
        content: { S: msg.content },
        timestamp: { S: new Date(baseTimestamp.getTime() + idx * 60000).toISOString() },
        isExample: { BOOL: true },
      },
    },
  }))

  // BatchWriteItem supports max 25 items per request
  for (let i = 0; i < transcriptPutRequests.length; i += 25) {
    const batch = transcriptPutRequests.slice(i, i + 25)
    await dynamo.send(new BatchWriteItemCommand({
      RequestItems: { [process.env.TRANSCRIPTS_TABLE]: batch },
    }))
  }
  log('info', 'CreateTenant: seeded example transcript', { tenantId, messageCount: fix.transcript.length })

  // 4. Write example report
  const reportRecord = {
    tenantId: { S: tenantId },
    sessionId: { S: sessionId },
    itemId: { S: itemId },
    verdict: { S: fix.report.verdict },
    conviction: { L: fix.report.conviction.map(c => ({ S: c })) },
    tension: { L: fix.report.tension.map(t => ({ S: t })) },
    uncertainty: { L: fix.report.uncertainty.map(u => ({ S: u })) },
    energy: { S: fix.report.energy },
    conversationShape: { S: fix.report.conversationShape },
    themes: { L: fix.report.themes.map(t => ({ S: t })) },
    isSelfReview: { BOOL: fix.report.isSelfReview },
    incomplete: { BOOL: fix.report.incomplete },
    generatedAt: { S: reportGeneratedAt },
    isExample: { BOOL: true },
  }
  await dynamo.send(new PutItemCommand({ TableName: process.env.REPORTS_TABLE, Item: reportRecord }))
  log('info', 'CreateTenant: seeded example report', { tenantId })

  // 5. Write example pulse check
  const pc = fix.pulseCheck
  const pulseCheckRecord = {
    tenantId: { S: tenantId },
    itemId: { S: itemId },
    verdict: { S: pc.verdict },
    narrative: { S: pc.narrative },
    themes: {
      L: pc.themes.map(t => ({
        M: {
          name: { S: t.name },
          summary: { S: t.summary },
          sentiment: { S: t.sentiment },
          quotes: { L: t.quotes.map(q => ({ S: q })) },
        },
      })),
    },
    sharedConviction: { L: pc.sharedConviction.map(s => ({ S: s })) },
    repeatedTension: { L: pc.repeatedTension.map(s => ({ S: s })) },
    openQuestions: { L: pc.openQuestions.map(s => ({ S: s })) },
    reviewerVerdicts: {
      L: pc.reviewerVerdicts.map(rv => ({
        M: {
          sessionId: { S: sessionId },
          reviewerName: { S: rv.reviewerName },
          verdict: { S: rv.verdict },
          energy: { S: rv.energy },
          conversationShape: { S: rv.conversationShape },
        },
      })),
    },
    proposedRevisions: {
      L: pc.proposedRevisions.map(pr => ({
        M: {
          title: { S: pr.title },
          description: { S: pr.description },
          sourceThemeIds: { L: pr.sourceThemeIds.map(id => ({ S: id })) },
        },
      })),
    },
    sessionCount: { N: String(pc.sessionCount) },
    incompleteCount: { N: String(pc.incompleteCount) },
    generatedAt: { S: pulseCheckGeneratedAt },
    status: { S: pc.status },
    isExample: { BOOL: true },
  }
  await dynamo.send(new PutItemCommand({ TableName: process.env.PULSE_CHECKS_TABLE, Item: pulseCheckRecord }))
  log('info', 'CreateTenant: seeded example pulse check', { tenantId })

  // 6. Write example document content to S3
  if (process.env.DATA_BUCKET && fix.documentContent) {
    const s3Key = `pulse/${tenantId}/items/${itemId}/extracted.md`
    await s3.send(new PutObjectCommand({
      Bucket: process.env.DATA_BUCKET,
      Key: s3Key,
      Body: fix.documentContent,
      ContentType: 'text/markdown',
    }))
    log('info', 'CreateTenant: seeded example document to S3', { tenantId, itemId })
  }
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

    // Seed example data — wrapped in try/catch so seeding failure never blocks tenant creation
    try {
      await seedExampleData(tenantId)
      log('info', 'CreateTenant: example data seeded', { requestId, tenantId })
    } catch (seedErr) {
      log('error', 'CreateTenant: example seeding failed, continuing', { requestId, tenantId, errorName: seedErr.name, message: seedErr.message })
    }
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
