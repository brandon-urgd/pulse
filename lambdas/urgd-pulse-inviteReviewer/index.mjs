// ur/gd pulse — Invite Reviewer Lambda
// POST /api/manage/items/{itemId}/invite → validates emails, creates sessions, sends invitations

import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { SESClient, SendEmailCommand, SendRawEmailCommand } from '@aws-sdk/client-ses'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { createResponse, errorResponse, log, requireEnv, isValidEmail } from './shared/utils.mjs'
import { randomUUID, randomBytes } from 'crypto'
import QRCode from 'qrcode'

// Fail-fast env var validation
requireEnv(['SESSIONS_TABLE', 'ITEMS_TABLE', 'DATA_BUCKET', 'CORS_ALLOWED_ORIGINS', 'APP_URL', 'ALERTS_TOPIC_ARN'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })
const ses = new SESClient({ region: process.env.AWS_REGION || 'us-west-2' })
const sns = new SNSClient({ region: process.env.AWS_REGION || 'us-west-2' })

const FROM_ADDRESS = 'pulse@urgdstudios.com'
const REPLY_TO_ADDRESS = 'no-reply@urgdstudios.com'
const DEFAULT_MAX_SESSIONS_FREE = 5
const DEFAULT_MAX_SESSIONS_PAID = 50

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
 * Builds a multipart/mixed MIME email with QR code attachment.
 * Returns a Buffer suitable for SES SendRawEmail.
 */
function buildRawEmail({ to, subject, htmlBody, textBody, qrCodeBuffer, sessionId }) {
  const boundary = `boundary_${randomUUID().replace(/-/g, '')}`
  const attachmentBoundary = `attach_${randomUUID().replace(/-/g, '')}`
  const qrBase64 = qrCodeBuffer.toString('base64')

  const lines = [
    `From: Pulse <${FROM_ADDRESS}>`,
    `To: ${to}`,
    `Reply-To: ${REPLY_TO_ADDRESS}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${attachmentBoundary}"`,
    '',
    `--${attachmentBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    textBody,
    '',
    `--${attachmentBoundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    htmlBody,
    '',
    `--${attachmentBoundary}--`,
    '',
    `--${boundary}`,
    `Content-Type: image/png; name="qr-${sessionId}.png"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="qr-${sessionId}.png"`,
    '',
    qrBase64,
    '',
    `--${boundary}--`,
  ]

  return Buffer.from(lines.join('\r\n'))
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

    // Determine maxSessionsPerItem from tenant tier (TENANTS_TABLE is optional — fall back to free defaults)
    let maxSessions = DEFAULT_MAX_SESSIONS_FREE
    if (process.env.TENANTS_TABLE) {
      try {
        const tenantRecord = await dynamo.send(new GetItemCommand({
          TableName: process.env.TENANTS_TABLE,
          Key: { tenantId: { S: tenantId } },
        }))
        if (tenantRecord.Item) {
          const tier = tenantRecord.Item.tier?.S ?? 'free'
          const featuresMap = tenantRecord.Item.features?.M ?? {}
          if (featuresMap.maxSessionsPerItem?.N !== undefined) {
            maxSessions = Number(featuresMap.maxSessionsPerItem.N)
          } else {
            maxSessions = tier === 'paid' ? DEFAULT_MAX_SESSIONS_PAID : DEFAULT_MAX_SESSIONS_FREE
          }
        }
      } catch (err) {
        log('warn', 'InviteReviewer: could not fetch tenant for feature flag, using free defaults', { requestId, tenantId })
      }
    }

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
          createdAt: { S: now },
          ...(closeDate ? { expiresAt: { S: closeDate } } : {}),
        },
      }))

      log('info', 'InviteReviewer: session created', { requestId, tenantId, itemId, sessionId })

      // Generate QR code PNG
      let qrCodeBuffer
      try {
        qrCodeBuffer = await QRCode.toBuffer(sessionLink, { type: 'png', width: 300 })
      } catch (qrErr) {
        log('error', 'InviteReviewer: QR code generation failed', { requestId, tenantId, itemId, sessionId, errorName: qrErr.name })
        qrCodeBuffer = null
      }

      // Store QR code in S3
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

      // Send invitation email via SES
      const subject = `You've been invited to review: ${itemName}`
      const textBody = [
        `You've been invited to provide feedback on "${itemName}".`,
        '',
        `Direct link: ${sessionLink}`,
        `Pulse Code: ${pulseCode}`,
        '',
        'You can also enter your Pulse Code at pulse.urgdstudios.com to access your session.',
        '',
        'This invitation was sent by Pulse, powered by ur/gd Studios.',
      ].join('\n')

      const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Pulse Invitation</title></head>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
  <h2 style="color: #1a1a1a;">You've been invited to review</h2>
  <p style="font-size: 16px;">You've been invited to provide feedback on <strong>${itemName}</strong>.</p>
  <p style="margin: 24px 0;">
    <a href="${sessionLink}" style="background: #4a7c59; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 16px;">
      Start Your Review
    </a>
  </p>
  <p style="font-size: 14px; color: #555;">Or enter your Pulse Code at <a href="${appUrl}">${appUrl}</a>:</p>
  <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px; font-family: monospace; color: #1a1a1a;">${pulseCode}</p>
  ${qrCodeBuffer ? `<p style="font-size: 14px; color: #555;">QR code attached for quick access.</p>` : ''}
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
  <p style="font-size: 12px; color: #999;">Sent by Pulse, powered by ur/gd Studios. Reply-to: ${REPLY_TO_ADDRESS}</p>
</body>
</html>`

      try {
        if (qrCodeBuffer) {
          // Send raw email with QR code attachment
          const rawMessage = buildRawEmail({ to: email, subject, htmlBody, textBody, qrCodeBuffer, sessionId })
          await ses.send(new SendRawEmailCommand({
            RawMessage: { Data: rawMessage },
          }))
        } else {
          // Send plain email without attachment
          await ses.send(new SendEmailCommand({
            Source: FROM_ADDRESS,
            Destination: { ToAddresses: [email] },
            ReplyToAddresses: [REPLY_TO_ADDRESS],
            Message: {
              Subject: { Data: subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: textBody, Charset: 'UTF-8' },
                Html: { Data: htmlBody, Charset: 'UTF-8' },
              },
            },
          }))
        }
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

    // Update item status to "active" and set lockedAt if this is the first invitation
    if (isFirstInvitation) {
      await dynamo.send(new UpdateItemCommand({
        TableName: process.env.ITEMS_TABLE,
        Key: {
          tenantId: { S: tenantId },
          itemId: { S: itemId },
        },
        UpdateExpression: 'SET #status = :active, lockedAt = :lockedAt, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':active': { S: 'active' },
          ':lockedAt': { S: now },
          ':now': { S: now },
        },
      }))
      log('info', 'InviteReviewer: item status updated to active', { requestId, tenantId, itemId })
    }

    log('info', 'InviteReviewer: completed', { requestId, tenantId, itemId, sessionCount: createdSessions.length })

    return createResponse(201, { data: { sessions: createdSessions } }, {}, origin)
  } catch (err) {
    log('error', 'InviteReviewer: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to process invitations', {}, origin)
  }
}
