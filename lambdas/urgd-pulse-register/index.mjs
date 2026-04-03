// ur/gd pulse — Register Lambda
// POST /api/auth/register → creates Cognito user + triggers createTenant

import { CognitoIdentityProviderClient, AdminCreateUserCommand } from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBClient, GetItemCommand, PutItemCommand, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { createResponse, errorResponse, log, requireEnv, isValidEmail } from './shared/utils.mjs'
import { getTierDefaults } from './shared/tiers.mjs'
import { ulid } from 'ulid'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// Fail-fast env var validation
requireEnv(['USER_POOL_ID', 'USER_POOL_CLIENT_ID', 'CORS_ALLOWED_ORIGINS', 'TENANTS_TABLE'])

const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-west-2' })
const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })

// Load example session fixtures at module init (bundled with Lambda)
let exampleFixtures = null
try {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const raw = readFileSync(join(__dirname, 'example-session-fixtures.json'), 'utf-8')
  exampleFixtures = JSON.parse(raw)
} catch (err) {
  console.warn('Register: failed to load example fixtures', err.message)
}

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

      // Seed example data — wrapped in try/catch so seeding failure never blocks registration
      try {
        await seedExampleData(tenantId)
        log('info', 'Register: example data seeded', { requestId, tenantId })
      } catch (seedErr) {
        log('error', 'Register: example seeding failed, continuing', { requestId, tenantId, errorName: seedErr.name, message: seedErr.message })
      }
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

/**
 * Seeds example data (item, session, transcript, report, pulse check) for a new tenant.
 * All records carry isExample: true. Failures are logged but do not block registration.
 */
async function seedExampleData(tenantId) {
  if (!exampleFixtures) {
    log('warn', 'Register: example fixtures not loaded, skipping seeding', { tenantId })
    return
  }

  if (!process.env.ITEMS_TABLE || !process.env.SESSIONS_TABLE || !process.env.TRANSCRIPTS_TABLE || !process.env.REPORTS_TABLE || !process.env.PULSE_CHECKS_TABLE) {
    log('warn', 'Register: missing table env vars for seeding, skipping', { tenantId })
    return
  }

  const itemId = ulid()
  const sessionId = ulid()
  const now = new Date()
  const createdAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const closedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString()
  const closeDate = closedAt
  const completedAt = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString()
  const reportGeneratedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000 + 60000).toISOString()
  const pulseCheckGeneratedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000 + 120000).toISOString()

  const fix = exampleFixtures

  await dynamo.send(new PutItemCommand({ TableName: process.env.ITEMS_TABLE, Item: {
    tenantId: { S: tenantId }, itemId: { S: itemId }, itemName: { S: fix.item.itemName },
    description: { S: fix.item.description }, status: { S: fix.item.status }, itemType: { S: fix.item.itemType },
    documentStatus: { S: fix.item.documentStatus }, documentKey: { S: `pulse/${tenantId}/items/${itemId}/extracted.md` },
    closeDate: { S: closeDate }, closedAt: { S: closedAt }, createdAt: { S: createdAt }, updatedAt: { S: closedAt },
    hasPulseCheck: { BOOL: true }, isExample: { BOOL: true },
    sessionCount: { N: String(fix.item.sessionCount) }, totalSections: { N: String(fix.item.totalSections) },
    recommendedTimeLimitMinutes: { N: String(fix.item.recommendedTimeLimitMinutes) }, lockedAt: { S: closedAt },
    sectionMap: { M: {
      sections: { L: fix.item.sectionMap.sections.map(s => ({ M: {
        id: { S: s.id }, title: { S: s.title }, classification: { S: s.classification }
      }}))},
      totalSubstantiveSections: { N: String(fix.item.sectionMap.totalSubstantiveSections) },
      analyzedAt: { S: createdAt },
    }},
    feedbackSections: { L: fix.item.feedbackSections.map(s => ({ S: s })) },
    sectionDepthPreferences: { M: Object.fromEntries(
      Object.entries(fix.item.sectionDepthPreferences).map(([k, v]) => [k, { S: v }])
    )},
    coverageMap: { M: Object.fromEntries(
      Object.entries(fix.item.coverageMap).map(([k, v]) => [k, { M: {
        sessionCount: { N: String(v.sessionCount) },
        avgDepth: { S: v.avgDepth },
        reviewerIds: { L: [{ S: sessionId }] },
      }}])
    )},
  }}))

  await dynamo.send(new PutItemCommand({ TableName: process.env.SESSIONS_TABLE, Item: {
    tenantId: { S: tenantId }, sessionId: { S: sessionId }, itemId: { S: itemId },
    reviewerName: { S: fix.session.reviewerName }, status: { S: fix.session.status },
    completedAt: { S: completedAt }, createdAt: { S: createdAt }, updatedAt: { S: completedAt },
    timeLimitMinutes: { N: String(fix.session.timeLimitMinutes) }, totalSections: { N: String(fix.session.totalSections) },
    isExample: { BOOL: true },
  }}))

  const baseTs = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000 - 20 * 60 * 1000)
  const transcriptPuts = fix.transcript.map((msg, idx) => ({
    PutRequest: { Item: {
      sessionId: { S: sessionId }, messageId: { S: ulid() }, role: { S: msg.role },
      content: { S: msg.content }, timestamp: { S: new Date(baseTs.getTime() + idx * 60000).toISOString() },
      isExample: { BOOL: true },
    }},
  }))
  for (let i = 0; i < transcriptPuts.length; i += 25) {
    await dynamo.send(new BatchWriteItemCommand({ RequestItems: { [process.env.TRANSCRIPTS_TABLE]: transcriptPuts.slice(i, i + 25) } }))
  }

  await dynamo.send(new PutItemCommand({ TableName: process.env.REPORTS_TABLE, Item: {
    tenantId: { S: tenantId }, sessionId: { S: sessionId }, itemId: { S: itemId },
    verdict: { S: fix.report.verdict }, conviction: { L: fix.report.conviction.map(c => ({ S: c })) },
    tension: { L: fix.report.tension.map(t => ({ S: t })) }, uncertainty: { L: fix.report.uncertainty.map(u => ({ S: u })) },
    energy: { S: fix.report.energy }, conversationShape: { S: fix.report.conversationShape },
    themes: { L: fix.report.themes.map(t => ({ S: t })) }, isSelfReview: { BOOL: fix.report.isSelfReview },
    incomplete: { BOOL: fix.report.incomplete }, generatedAt: { S: reportGeneratedAt }, isExample: { BOOL: true },
  }}))

  const pc = fix.pulseCheck
  await dynamo.send(new PutItemCommand({ TableName: process.env.PULSE_CHECKS_TABLE, Item: {
    tenantId: { S: tenantId }, itemId: { S: itemId }, verdict: { S: pc.verdict }, narrative: { S: pc.narrative },
    themes: { L: pc.themes.map(t => ({ M: {
      themeId: { S: t.themeId }, label: { S: t.label },
      reviewerSignals: { L: t.reviewerSignals.map(rs => ({ M: {
        sessionId: { S: sessionId }, signalType: { S: rs.signalType }, quote: { S: rs.quote },
      } })) },
    } })) },
    sharedConviction: { L: pc.sharedConviction.map(s => ({ S: s })) }, repeatedTension: { L: pc.repeatedTension.map(s => ({ S: s })) },
    openQuestions: { L: pc.openQuestions.map(s => ({ S: s })) },
    reviewerVerdicts: { L: pc.reviewerVerdicts.map(rv => ({ M: {
      sessionId: { S: sessionId }, verdict: { S: rv.verdict }, energy: { S: rv.energy }, isSelfReview: { BOOL: rv.isSelfReview },
    } })) },
    proposedRevisions: { L: pc.proposedRevisions.map(pr => ({ M: {
      revisionId: { S: pr.revisionId }, proposal: { S: pr.proposal }, rationale: { S: pr.rationale },
      revisionType: { S: pr.revisionType }, sourceThemeIds: { L: pr.sourceThemeIds.map(id => ({ S: id })) },
    } })) },
    sessionCount: { N: String(pc.sessionCount) }, incompleteCount: { N: String(pc.incompleteCount) },
    generatedAt: { S: pulseCheckGeneratedAt }, status: { S: pc.status }, isExample: { BOOL: true },
  }}))

  if (process.env.DATA_BUCKET && fix.documentContent) {
    await s3.send(new PutObjectCommand({ Bucket: process.env.DATA_BUCKET, Key: `pulse/${tenantId}/items/${itemId}/extracted.md`, Body: fix.documentContent, ContentType: 'text/markdown' }))
  }

  log('info', 'Register: example data seeded', { tenantId, itemId })
}
