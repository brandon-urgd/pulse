// ur/gd pulse — Resend Invite Lambda
// POST /api/manage/items/{itemId}/sessions/{sessionId}/resend

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { SESClient, SendEmailCommand, SendRawEmailCommand } from '@aws-sdk/client-ses'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { randomUUID } from 'crypto'

// Fail-fast env var validation
requireEnv(['SESSIONS_TABLE', 'ITEMS_TABLE', 'DATA_BUCKET', 'CORS_ALLOWED_ORIGINS', 'APP_URL', 'ALERTS_TOPIC_ARN'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })
const ses = new SESClient({ region: process.env.AWS_REGION || 'us-west-2' })
const sns = new SNSClient({ region: process.env.AWS_REGION || 'us-west-2' })

const FROM_ADDRESS = 'pulse@urgdstudios.com'
const REPLY_TO_ADDRESS = 'no-reply@urgdstudios.com'

/**
 * Builds a multipart/mixed MIME email with QR code attachment.
 * Returns a Buffer suitable for SES SendRawEmail.
 */
function buildRawEmail({ to, subject, htmlBody, textBody, qrCodeBuffer, sessionId, replyTo }) {
  const boundary = `boundary_${randomUUID().replace(/-/g, '')}`
  const attachmentBoundary = `attach_${randomUUID().replace(/-/g, '')}`
  const qrBase64 = qrCodeBuffer.toString('base64')

  const lines = [
    `From: Pulse <${FROM_ADDRESS}>`,
    `To: ${to}`,
    `Reply-To: ${replyTo}`,
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
  const sessionId = event?.pathParameters?.sessionId

  if (!tenantId) {
    log('warn', 'ResendInvite: missing tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!itemId || !sessionId) {
    return errorResponse(400, 'itemId and sessionId are required', {}, origin)
  }

  try {
    // Fetch session from SESSIONS_TABLE (tenantId as PK, sessionId as SK)
    const sessionResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        sessionId: { S: sessionId },
      },
    }))

    if (!sessionResult.Item) {
      log('warn', 'ResendInvite: session not found', { requestId, tenantId, sessionId })
      return errorResponse(404, 'Session not found', {}, origin)
    }

    const session = sessionResult.Item

    // Verify session belongs to the correct item
    if (session.itemId?.S !== itemId) {
      log('warn', 'ResendInvite: session does not belong to item', { requestId, tenantId, sessionId, itemId })
      return errorResponse(404, 'Session not found', {}, origin)
    }

    // Validate session status is "not_started"
    const sessionStatus = session.status?.S
    if (sessionStatus !== 'not_started') {
      log('warn', 'ResendInvite: session already started', { requestId, tenantId, sessionId, sessionStatus })
      return errorResponse(409, 'Cannot resend invitation for a session that has already started', {}, origin)
    }

    const reviewerEmail = session.reviewerEmail?.S
    const pulseCode = session.pulseCode?.S
    const sessionLink = `${process.env.APP_URL}/s/${sessionId}`

    // Fetch item name from ITEMS_TABLE
    const itemResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
      },
    }))

    const itemName = itemResult.Item?.itemName?.S ?? 'Untitled Item'
    const closeDate = itemResult.Item?.closeDate?.S ?? null

    // Fetch tenant record for inviter identity
    let inviterName = null
    let inviterEmail = null
    if (process.env.TENANTS_TABLE) {
      try {
        const tenantRecord = await dynamo.send(new GetItemCommand({
          TableName: process.env.TENANTS_TABLE,
          Key: { tenantId: { S: tenantId } },
        }))
        if (tenantRecord.Item) {
          inviterName = tenantRecord.Item.displayName?.S ?? null
          inviterEmail = tenantRecord.Item.email?.S ?? null
        }
      } catch {
        log('warn', 'ResendInvite: could not fetch tenant record', { requestId, tenantId })
      }
    }

    const inviterDisplay = inviterName ?? 'Someone'
    const replyTo = inviterEmail ?? FROM_ADDRESS
    const closeDateFormatted = closeDate
      ? new Date(closeDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : null

    // Attempt to load QR code from S3
    let qrCodeBuffer = null
    const qrKey = `pulse/${tenantId}/items/${itemId}/qr/${sessionId}.png`
    try {
      const s3Result = await s3.send(new GetObjectCommand({
        Bucket: process.env.DATA_BUCKET,
        Key: qrKey,
      }))
      const chunks = []
      for await (const chunk of s3Result.Body) {
        chunks.push(chunk)
      }
      qrCodeBuffer = Buffer.concat(chunks)
      log('info', 'ResendInvite: QR code loaded from S3', { requestId, tenantId, itemId, sessionId })
    } catch (s3Err) {
      // Gracefully handle missing QR code — send email without attachment
      log('info', 'ResendInvite: QR code not found in S3, sending without attachment', { requestId, tenantId, itemId, sessionId, errorName: s3Err.name })
    }

    // Build email content
    const subject = `${inviterDisplay} invited you to provide feedback on "${itemName}"`
    const appUrl = process.env.APP_URL

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
      'ur/gd Studios LLC · 1424 11th Ave STE 400, Seattle, WA 98122-4271',
      'Privacy Policy: https://www.urgdstudios.com/privacy | Terms: https://www.urgdstudios.com/terms',
    ].join('\n')

    const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Pulse Invitation</title></head>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
  <h2 style="color: #1a1a1a; margin-bottom: 8px;">You've been invited to review</h2>
  <p style="font-size: 16px; margin-top: 0;">
    <strong>${inviterDisplay}</strong> has invited you to provide feedback on <strong>${itemName}</strong>.
  </p>
  ${closeDateFormatted ? `<p style="font-size: 14px; color: #555; margin-top: 0;">Feedback will close on <strong>${closeDateFormatted}</strong>.</p>` : ''}
  ${inviterEmail ? `<p style="font-size: 14px; color: #555;">For questions, contact <a href="mailto:${inviterEmail}" style="color:#4a7c59;">${inviterEmail}</a>.</p>` : ''}
  <p style="margin: 28px 0;">
    <a href="${sessionLink}" style="background: #4a7c59; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 16px; display: inline-block;">
      Start Your Review
    </a>
  </p>
  <p style="font-size: 14px; color: #555;">Or enter your Pulse Code at <a href="${appUrl}" style="color:#4a7c59;">pulse.urgdstudios.com</a>:</p>
  <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px; font-family: monospace; color: #1a1a1a; margin: 8px 0 24px;">${pulseCode}</p>
  ${qrCodeBuffer ? `<p style="font-size: 14px; color: #555;">QR code attached for quick access.</p>` : ''}
  <hr style="border: none; border-top: 1px solid #eee; margin: 28px 0 16px;">
  <p style="font-size: 11px; color: #999; margin: 4px 0;">
    Sent by Pulse, powered by <a href="https://www.urgdstudios.com" style="color:#999;">ur/gd Studios</a>
  </p>
  <p style="font-size: 11px; color: #999; margin: 4px 0;">
    ur/gd Studios LLC &middot; 1424 11th Ave STE 400, Seattle, WA 98122-4271
  </p>
  <p style="font-size: 11px; color: #999; margin: 4px 0;">
    <a href="https://www.urgdstudios.com/privacy" style="color:#999;">Privacy Policy</a>
    &nbsp;&middot;&nbsp;
    <a href="https://www.urgdstudios.com/terms" style="color:#999;">Terms of Use</a>
  </p>
</body>
</html>`

    // Send invitation email via SES
    try {
      if (qrCodeBuffer) {
        const rawMessage = buildRawEmail({ to: reviewerEmail, subject, htmlBody, textBody, qrCodeBuffer, sessionId, replyTo })
        await ses.send(new SendRawEmailCommand({
          RawMessage: { Data: rawMessage },
        }))
      } else {
        await ses.send(new SendEmailCommand({
          Source: FROM_ADDRESS,
          Destination: { ToAddresses: [reviewerEmail] },
          ReplyToAddresses: [replyTo],
          Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: textBody, Charset: 'UTF-8' },
              Html: { Data: htmlBody, Charset: 'UTF-8' },
            },
          },
        }))
      }
      log('info', 'ResendInvite: invitation email sent', { requestId, tenantId, itemId, sessionId })
    } catch (sesErr) {
      log('error', 'ResendInvite: SES send failed', { requestId, tenantId, itemId, sessionId, errorName: sesErr.name })

      // Publish alert to SNS
      try {
        await sns.send(new PublishCommand({
          TopicArn: process.env.ALERTS_TOPIC_ARN,
          Subject: 'Pulse: Resend invitation email delivery failure',
          Message: JSON.stringify({
            alert: 'ses_resend_failure',
            tenantId,
            itemId,
            sessionId,
            timestamp: new Date().toISOString(),
          }),
        }))
      } catch (snsErr) {
        log('error', 'ResendInvite: SNS alert publish failed', { requestId, tenantId, errorName: snsErr.name })
      }

      return errorResponse(502, 'Failed to send invitation email', {}, origin)
    }

    log('info', 'ResendInvite: completed', { requestId, tenantId, itemId, sessionId })
    return createResponse(200, { data: { sessionId, status: 'not_started' } }, {}, origin)
  } catch (err) {
    log('error', 'ResendInvite: unexpected error', { requestId, tenantId, itemId, sessionId, errorName: err.name })
    return errorResponse(500, 'Internal server error', {}, origin)
  }
}
