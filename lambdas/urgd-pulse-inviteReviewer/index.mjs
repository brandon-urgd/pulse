// ur/gd pulse — Invite Reviewer Lambda
// POST /api/manage/items/{itemId}/invite → validates emails, creates sessions, sends invitations

import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { createResponse, errorResponse, log, requireEnv, isValidEmail } from './shared/utils.mjs'
import { resolveFeature } from './shared/features.mjs'
import { randomBytes, randomUUID } from 'crypto'
import QRCode from 'qrcode'

// Fail-fast env var validation
requireEnv(['SESSIONS_TABLE', 'ITEMS_TABLE', 'DATA_BUCKET', 'CORS_ALLOWED_ORIGINS', 'APP_URL', 'ALERTS_TOPIC_ARN'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })
const ses = new SESClient({ region: process.env.AWS_REGION || 'us-west-2' })
const sns = new SNSClient({ region: process.env.AWS_REGION || 'us-west-2' })

const FROM_ADDRESS = 'Pulse <pulse@urgdstudios.com>'

function unmarshalFeatures(m) {
  if (!m) return {}
  const result = {}
  for (const [key, val] of Object.entries(m)) {
    if ('N' in val) result[key] = Number(val.N)
    else if ('BOOL' in val) result[key] = val.BOOL
    else if ('S' in val) result[key] = val.S
    else if ('M' in val) result[key] = unmarshalFeatures(val.M)
  }
  return result
}

/**
 * Generates a unique 8-character alphanumeric pulse code.
 */
function generatePulseCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous chars (0/O, 1/I)
  let code = ''
  const bytes = randomBytes(8)
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length]
  }
  return code
}

/**
 * Builds the invitation email HTML body with a Gmail-compatible table-based button.
 */
function buildInviteHtml({ inviterDisplay, itemName, closeDateFormatted, sessionLink, pulseCode, appUrl, inviterEmail }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Pulse Invitation</title></head>
<body style="max-width:600px;margin:0 auto;padding:24px;color:#111827;font-family:'Rubik',sans-serif;background:#ffffff;">
  <h2 style="font-family:'Archivo',sans-serif;font-size:22px;font-weight:700;color:#111827;margin:0 0 16px;">You've been invited to review</h2>
  <p style="font-size:16px;line-height:1.6;margin:0 0 12px;">
    <strong>${inviterDisplay}</strong> has invited you to provide feedback on <strong>${itemName}</strong>.
  </p>
  ${closeDateFormatted ? `<p style="font-size:14px;color:#4b5563;margin:0 0 12px;">Feedback will close on <strong>${closeDateFormatted}</strong>.</p>` : ''}
  ${inviterEmail ? `<p style="font-size:14px;color:#4b5563;margin:0 0 20px;">For questions, contact <a href="mailto:${inviterEmail}" style="color:#7a9e87;">${inviterEmail}</a>.</p>` : ''}
  <table cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
    <tr>
      <td style="background-color:#7a9e87;border-radius:8px;padding:12px 24px;">
        <a href="${sessionLink}" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;font-family:'Rubik',sans-serif;">
          Start Your Review
        </a>
      </td>
    </tr>
  </table>
  <p style="font-size:14px;color:#4b5563;margin:0 0 8px;">Or enter your Pulse Code at <a href="${appUrl}" style="color:#7a9e87;">pulse.urgdstudios.com</a>:</p>
  <p style="font-size:28px;font-weight:700;letter-spacing:4px;font-family:monospace;color:#111827;margin:8px 0 24px;">${pulseCode}</p>
  <p style="font-size:13px;color:#4b5563;margin:0 0 28px;">Direct link: <a href="${sessionLink}" style="color:#7a9e87;">${sessionLink}</a></p>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 16px;">
  <p style="font-size:11px;color:#6b7280;margin:4px 0;">
    Sent by Pulse, powered by <a href="https://www.urgdstudios.com" style="color:#6b7280;">ur/gd Studios</a>
  </p>
  <p style="font-size:11px;color:#6b7280;margin:4px 0;">
    ur/gd Studios LLC &middot; The Cloud Room &middot; 1424 11th Ave STE 400 &middot; Seattle, WA 98122-4271
  </p>
  <p style="font-size:11px;color:#6b7280;margin:4px 0;">
    <a href="https://www.urgdstudios.com/privacy" style="color:#6b7280;">Privacy Policy</a>
    &nbsp;&middot;&nbsp;
    <a href="https://www.urgdstudios.com/terms" style="color:#6b7280;">Terms of Use</a>
  </p>
</body>
</html>`
}

/**
 * Build initial sectionCoverage map from item's feedbackSections (5.5).
 * All included sections start as { touched: false, depth: null }.
 */
function buildInitialSectionCoverage(item) {
  const feedbackSections = item.feedbackSections?.L
  if (!feedbackSections || feedbackSections.length === 0) return { M: {} }
  const m = {}
  for (const s of feedbackSections) {
    const sId = s.S || s
    if (sId) {
      m[sId] = { M: { touched: { BOOL: false }, depth: { NULL: true } } }
    }
  }
  return { M: m }
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) {
    log('warn', 'InviteReviewer: missing tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!itemId) {
    return errorResponse(400, 'itemId is required', {}, origin)
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return errorResponse(400, 'Invalid request body', {}, origin)
  }

  const { emails } = body

  // Validate emails array
  if (!Array.isArray(emails) || emails.length === 0) {
    return errorResponse(400, 'emails must be a non-empty array', {}, origin)
  }

  const invalidEmails = emails.filter(e => typeof e !== 'string' || !isValidEmail(e))
  if (invalidEmails.length > 0) {
    return errorResponse(400, 'All emails must be valid email addresses', {}, origin)
  }

  try {
    // Fetch item to verify ownership and get closeDate
    const itemResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
      },
    }))

    if (!itemResult.Item) {
      log('warn', 'InviteReviewer: item not found', { requestId, tenantId, itemId })
      return errorResponse(404, 'Item not found', {}, origin)
    }

    const item = itemResult.Item
    const itemStatus = item.status?.S
    const closeDate = item.closeDate?.S
    const itemName = item.itemName?.S ?? 'Untitled Item'
    // Read recommended time limit from item — written by extractText/shieldCallback
    // Snap to bracket midpoints: 12, 17, 25, 37. Default to 17 (15–20 min) if not set.
    const BRACKETS = [12, 17, 25, 37]
    const rawItemMinutes = item.recommendedTimeLimitMinutes?.N
      ? parseInt(item.recommendedTimeLimitMinutes.N, 10)
      : null
    const sessionTimeLimitMinutes = rawItemMinutes
      ? BRACKETS.reduce((best, b) => Math.abs(b - rawItemMinutes) < Math.abs(best - rawItemMinutes) ? b : best, BRACKETS[0])
      : 17

    // Cap time limit by tier limit
    const cappedTimeLimitMinutes = Math.min(sessionTimeLimitMinutes, maxTimeLimit)

    // Item must be draft or active to invite
    if (itemStatus !== 'draft' && itemStatus !== 'active') {
      return errorResponse(409, 'Item is not accepting new invitations', {}, origin)
    }

    // Get existing session count for this item
    const existingSessionsResult = await dynamo.send(new QueryCommand({
      TableName: process.env.SESSIONS_TABLE,
      IndexName: 'item-index',
      KeyConditionExpression: 'itemId = :iid',
      ExpressionAttributeValues: { ':iid': { S: itemId } },
      Select: 'COUNT',
    }))

    const existingCount = existingSessionsResult.Count ?? 0

    // Fetch tenant record for feature flags + inviter identity
    let maxSessions = 5
    let inviterName = null
    let inviterEmail = null
    let tenantRecord = { tier: 'free', features: {}, serviceFlags: {} }
    let systemRecord = null
    if (process.env.TENANTS_TABLE) {
      try {
        const [tenantFetch, systemFetch] = await Promise.all([
          dynamo.send(new GetItemCommand({
            TableName: process.env.TENANTS_TABLE,
            Key: { tenantId: { S: tenantId } },
          })),
          dynamo.send(new GetItemCommand({
            TableName: process.env.TENANTS_TABLE,
            Key: { tenantId: { S: 'SYSTEM' } },
          })),
        ])
        if (tenantFetch.Item) {
          tenantRecord = {
            tier: tenantFetch.Item.tier?.S ?? 'free',
            features: unmarshalFeatures(tenantFetch.Item.features?.M),
            serviceFlags: unmarshalFeatures(tenantFetch.Item.serviceFlags?.M),
          }
          inviterName = tenantFetch.Item.displayName?.S ?? null
          inviterEmail = tenantFetch.Item.email?.S ?? null
        }
        if (systemFetch.Item) {
          systemRecord = { serviceFlags: unmarshalFeatures(systemFetch.Item.serviceFlags?.M) }
        }
      } catch (err) {
        log('warn', 'InviteReviewer: could not fetch tenant record, using defaults', { requestId, tenantId })
      }
    }

    // Check maxSessionsPerItem limit
    const maxSessionsResult = resolveFeature(tenantRecord, 'maxSessionsPerItem', systemRecord)
    maxSessions = maxSessionsResult.limit ?? 5

    // Check sessionTimeLimitMinutes
    const timeLimitResult = resolveFeature(tenantRecord, 'sessionTimeLimitMinutes', systemRecord)
    const maxTimeLimit = timeLimitResult.limit ?? 120

    if (existingCount + emails.length > maxSessions) {
      log('warn', 'InviteReviewer: session limit exceeded', { requestId, tenantId, itemId, existingCount, requested: emails.length, maxSessions })
      return errorResponse(403, 'Session limit reached for this item.', {}, origin)
    }

    const appUrl = process.env.APP_URL
    const isFirstInvitation = itemStatus === 'draft'
    const now = new Date().toISOString()
    const createdSessions = []

    for (const email of emails) {
      const sessionId = randomUUID()
      const pulseCode = generatePulseCode()
      const sessionLink = `${appUrl}/s/${sessionId}`

      // Create session record in DynamoDB
      await dynamo.send(new PutItemCommand({
        TableName: process.env.SESSIONS_TABLE,
        Item: {
          tenantId: { S: tenantId },
          sessionId: { S: sessionId },
          itemId: { S: itemId },
          reviewerEmail: { S: email },
          pulseCode: { S: pulseCode },
          status: { S: 'not_started' },
          timeLimitMinutes: { N: String(cappedTimeLimitMinutes) },
          createdAt: { S: now },
          ...(closeDate ? { expiresAt: { S: closeDate } } : {}),
          // 5.5: Frozen snapshot — store section data at session creation time
          ...(item.sectionMap?.M ? {
            frozenSnapshot: {
              M: {
                sectionMap: item.sectionMap,
                feedbackSections: item.feedbackSections || { L: [] },
                sectionDepthPreferences: item.sectionDepthPreferences || { M: {} },
              },
            },
            sectionCoverage: buildInitialSectionCoverage(item),
          } : {
            // No sectionMap — set totalSections explicitly (image items = 1, fallback = 5)
            totalSections: { N: String(item.totalSections?.N || '5') },
          }),
        },
      }))

      log('info', 'InviteReviewer: session created', { requestId, tenantId, itemId, sessionId })

      // Generate QR code PNG and store in S3 (for public session / admin display use)
      let qrCodeBuffer
      try {
        qrCodeBuffer = await QRCode.toBuffer(sessionLink, { type: 'png', width: 300 })
      } catch (qrErr) {
        log('error', 'InviteReviewer: QR code generation failed', { requestId, tenantId, itemId, sessionId, errorName: qrErr.name })
        qrCodeBuffer = null
      }

      if (qrCodeBuffer) {
        const qrKey = `pulse/${tenantId}/items/${itemId}/qr/${sessionId}.png`
        try {
          await s3.send(new PutObjectCommand({
            Bucket: process.env.DATA_BUCKET,
            Key: qrKey,
            Body: qrCodeBuffer,
            ContentType: 'image/png',
          }))
          log('info', 'InviteReviewer: QR code stored in S3', { requestId, tenantId, itemId, sessionId })
        } catch (s3Err) {
          log('error', 'InviteReviewer: failed to store QR code in S3', { requestId, tenantId, itemId, sessionId, errorName: s3Err.name })
        }
      }

      // Send invitation email via SES (no QR attachment — QR is for public/event use only)
      const inviterDisplay = inviterName ?? 'Someone'
      const replyTo = inviterEmail ?? FROM_ADDRESS
      const closeDateFormatted = closeDate
        ? new Date(closeDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        : null

      const subject = `${inviterDisplay} invited you to provide feedback on "${itemName}"`

      const textBody = [
        `${inviterDisplay} has invited you to provide feedback on "${itemName}".`,
        ...(closeDateFormatted ? [`Feedback will close on ${closeDateFormatted}.`] : []),
        '',
        `Start your review: ${sessionLink}`,
        '',
        `Or enter your Pulse Code at pulse.urgdstudios.com: ${pulseCode}`,
        '',
        ...(inviterEmail ? [`For questions, contact ${inviterEmail}.`, ''] : []),
        '---',
        'Sent by Pulse, powered by ur/gd Studios (https://www.urgdstudios.com)',
        'ur/gd Studios LLC · The Cloud Room · 1424 11th Ave STE 400 · Seattle, WA 98122-4271',
        'Privacy Policy: https://www.urgdstudios.com/privacy | Terms: https://www.urgdstudios.com/terms',
      ].join('\n')

      const htmlBody = buildInviteHtml({ inviterDisplay, itemName, closeDateFormatted, sessionLink, pulseCode, appUrl, inviterEmail })

      try {
        await ses.send(new SendEmailCommand({
          Source: FROM_ADDRESS,
          Destination: { ToAddresses: [email] },
          ReplyToAddresses: [replyTo],
          Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: textBody, Charset: 'UTF-8' },
              Html: { Data: htmlBody, Charset: 'UTF-8' },
            },
          },
        }))
        log('info', 'InviteReviewer: invitation email sent', { requestId, tenantId, itemId, sessionId })
      } catch (sesErr) {
        log('error', 'InviteReviewer: SES send failed', { requestId, tenantId, itemId, sessionId, errorName: sesErr.name })
        // Publish alert to SNS — do NOT throw, continue processing
        try {
          await sns.send(new PublishCommand({
            TopicArn: process.env.ALERTS_TOPIC_ARN,
            Subject: 'Pulse: Invitation email delivery failure',
            Message: JSON.stringify({
              alert: 'ses_send_failure',
              tenantId,
              itemId,
              sessionId,
              timestamp: new Date().toISOString(),
            }),
          }))
        } catch (snsErr) {
          log('error', 'InviteReviewer: SNS alert publish failed', { requestId, tenantId, errorName: snsErr.name })
        }
      }

      createdSessions.push({ sessionId, pulseCode, status: 'not_started' })
    }

    // Update item: always increment sessionCount; on first invitation also set status → active
    if (isFirstInvitation) {
      await dynamo.send(new UpdateItemCommand({
        TableName: process.env.ITEMS_TABLE,
        Key: {
          tenantId: { S: tenantId },
          itemId: { S: itemId },
        },
        UpdateExpression: 'SET #status = :active, lockedAt = :lockedAt, updatedAt = :now ADD sessionCount :n',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':active': { S: 'active' },
          ':lockedAt': { S: now },
          ':now': { S: now },
          ':n': { N: String(createdSessions.length) },
        },
      }))
      log('info', 'InviteReviewer: item status updated to active', { requestId, tenantId, itemId })
    } else {
      await dynamo.send(new UpdateItemCommand({
        TableName: process.env.ITEMS_TABLE,
        Key: {
          tenantId: { S: tenantId },
          itemId: { S: itemId },
        },
        UpdateExpression: 'SET updatedAt = :now ADD sessionCount :n',
        ExpressionAttributeValues: {
          ':now': { S: now },
          ':n': { N: String(createdSessions.length) },
        },
      }))
    }

    log('info', 'InviteReviewer: completed', { requestId, tenantId, itemId, sessionCount: createdSessions.length })

    return createResponse(201, { data: { sessions: createdSessions } }, {}, origin)
  } catch (err) {
    log('error', 'InviteReviewer: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to process invitations', {}, origin)
  }
}
