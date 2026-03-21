// ur/gd pulse — Send Reminder Lambda (scheduled job)
// Triggered by EventBridge on hourly schedule
// Scans sessions approaching deadline and sends reminder emails via SES

import { DynamoDBClient, ScanCommand, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { log, requireEnv } from './shared/utils.mjs'

// Fail-fast env var validation
requireEnv(['SESSIONS_TABLE', 'ITEMS_TABLE', 'TENANTS_TABLE', 'ALERTS_TOPIC_ARN', 'APP_URL'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const ses = new SESClient({ region: process.env.AWS_REGION || 'us-west-2' })
const sns = new SNSClient({ region: process.env.AWS_REGION || 'us-west-2' })

const FROM_ADDRESS = 'Pulse <pulse@urgdstudios.com>'
const REMINDER_WINDOW_HOURS = 48

/**
 * Fetches the emailReminders feature flag and inviter email for a tenant.
 * Returns { enabled: true, inviterEmail: null } by default if tenant record not found.
 */
async function getTenantInfo(tenantId) {
  try {
    const result = await dynamo.send(new GetItemCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
    }))
    if (!result.Item) return { enabled: true, inviterEmail: null }
    const featuresMap = result.Item.features?.M ?? {}
    const enabled = featuresMap.emailReminders?.BOOL !== false
    const inviterEmail = result.Item.email?.S ?? null
    return { enabled, inviterEmail }
  } catch (err) {
    log('warn', 'SendReminder: failed to fetch tenant info, defaulting to enabled', { tenantId, errorName: err.name })
    return { enabled: true, inviterEmail: null }
  }
}

/**
 * Fetches item record to get closeDate and itemName.
 */
async function getItem(tenantId, itemId) {
  try {
    const result = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
      },
    }))
    return result.Item ?? null
  } catch (err) {
    log('warn', 'SendReminder: failed to fetch item', { tenantId, itemId, errorName: err.name })
    return null
  }
}

/**
 * Sends a reminder email via SES. On failure, publishes alert to SNS.
 */
async function sendReminderEmail({ reviewerEmail, itemName, sessionLink, pulseCode, closeDate, tenantId, sessionId, inviterEmail }) {
  const closeDateFormatted = new Date(closeDate).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })

  const subject = `Reminder: Your review of "${itemName}" is due soon`
  const textBody = [
    `This is a reminder that your review of "${itemName}" is due on ${closeDateFormatted}.`,
    '',
    `Direct link: ${sessionLink}`,
    `Pulse Code: ${pulseCode}`,
    '',
    'You can also enter your Pulse Code at pulse.urgdstudios.com to access your session.',
    '',
    '---',
    'Sent by Pulse, powered by ur/gd Studios (https://www.urgdstudios.com)',
    'ur/gd Studios LLC · The Cloud Room · 1424 11th Ave STE 400 · Seattle, WA 98122-4271',
    'Privacy Policy: https://www.urgdstudios.com/privacy | Terms: https://www.urgdstudios.com/terms',
  ].join('\n')

  const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Pulse Reminder</title></head>
<body style="max-width:600px;margin:0 auto;padding:24px;color:#111827;font-family:'Rubik',sans-serif;background:#ffffff;">
  <h2 style="font-family:'Archivo',sans-serif;font-size:22px;font-weight:700;color:#111827;margin:0 0 16px;">Your review is due soon</h2>
  <p style="font-size:16px;line-height:1.6;margin:0 0 12px;">This is a reminder that your review of <strong>${itemName}</strong> is due on <strong>${closeDateFormatted}</strong>.</p>
  <table cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
    <tr>
      <td style="background-color:#7a9e87;border-radius:8px;padding:12px 24px;">
        <a href="${sessionLink}" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;font-family:'Rubik',sans-serif;">
          Continue Your Review
        </a>
      </td>
    </tr>
  </table>
  <p style="font-size:14px;color:#4b5563;margin:0 0 8px;">Or enter your Pulse Code at <a href="${process.env.APP_URL}" style="color:#7a9e87;">pulse.urgdstudios.com</a>:</p>
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

  try {
    await ses.send(new SendEmailCommand({
      Source: FROM_ADDRESS,
      Destination: { ToAddresses: [reviewerEmail] },
      ReplyToAddresses: [inviterEmail ?? FROM_ADDRESS],
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: textBody, Charset: 'UTF-8' },
          Html: { Data: htmlBody, Charset: 'UTF-8' },
        },
      },
    }))
    log('info', 'SendReminder: reminder email sent', { tenantId, sessionId })
    return true
  } catch (sesErr) {
    log('error', 'SendReminder: SES send failed', { tenantId, sessionId, errorName: sesErr.name })
    try {
      await sns.send(new PublishCommand({
        TopicArn: process.env.ALERTS_TOPIC_ARN,
        Subject: 'Pulse: Reminder email delivery failure',
        Message: JSON.stringify({
          alert: 'ses_reminder_failure',
          tenantId,
          sessionId,
          timestamp: new Date().toISOString(),
        }),
      }))
    } catch (snsErr) {
      log('error', 'SendReminder: SNS alert publish failed', { tenantId, sessionId, errorName: snsErr.name })
    }
    return false
  }
}

export const handler = async (event) => {
  log('info', 'SendReminder: job started', { trigger: event?.source ?? 'unknown' })

  const now = new Date()
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_HOURS * 60 * 60 * 1000)

  let totalScanned = 0
  let totalSent = 0
  let totalSkipped = 0
  let lastEvaluatedKey

  // Scan sessions table for not_started or in_progress sessions
  do {
    const scanResult = await dynamo.send(new ScanCommand({
      TableName: process.env.SESSIONS_TABLE,
      FilterExpression: '#status IN (:ns, :ip)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':ns': { S: 'not_started' },
        ':ip': { S: 'in_progress' },
      },
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    }))

    lastEvaluatedKey = scanResult.LastEvaluatedKey
    const sessions = scanResult.Items ?? []
    totalScanned += sessions.length

    // Group sessions by tenantId to batch tenant feature flag lookups
    const tenantFlagCache = new Map()

    for (const session of sessions) {
      const tenantId = session.tenantId?.S
      const sessionId = session.sessionId?.S
      const itemId = session.itemId?.S
      const reviewerEmail = session.reviewerEmail?.S
      const pulseCode = session.pulseCode?.S
      const expiresAt = session.expiresAt?.S

      if (!tenantId || !sessionId || !itemId || !reviewerEmail || !pulseCode) {
        log('warn', 'SendReminder: skipping session with missing fields', { sessionId })
        totalSkipped++
        continue
      }

      // Check if session is already expired by date
      if (expiresAt && new Date(expiresAt) < now) {
        totalSkipped++
        continue
      }

      // Fetch item to check closeDate
      const item = await getItem(tenantId, itemId)
      if (!item) {
        totalSkipped++
        continue
      }

      const closeDate = item.closeDate?.S
      if (!closeDate) {
        totalSkipped++
        continue
      }

      const closeDateObj = new Date(closeDate)

      // Only send reminder if closeDate is within the next 48 hours (and not already past)
      if (closeDateObj <= now || closeDateObj > windowEnd) {
        totalSkipped++
        continue
      }

      // Check emailReminders feature flag (cached per tenant)
      if (!tenantFlagCache.has(tenantId)) {
        const info = await getTenantInfo(tenantId)
        tenantFlagCache.set(tenantId, info)
      }

      const tenantInfo = tenantFlagCache.get(tenantId)
      if (!tenantInfo.enabled) {
        log('info', 'SendReminder: emailReminders disabled for tenant', { tenantId })
        totalSkipped++
        continue
      }

      const itemName = item.itemName?.S ?? 'Untitled Item'
      const sessionLink = `${process.env.APP_URL}/s/${sessionId}`

      const sent = await sendReminderEmail({
        reviewerEmail,
        itemName,
        sessionLink,
        pulseCode,
        closeDate,
        tenantId,
        sessionId,
        inviterEmail: tenantInfo.inviterEmail,
      })

      if (sent) totalSent++
      else totalSkipped++
    }
  } while (lastEvaluatedKey)

  log('info', 'SendReminder: job completed', { totalScanned, totalSent, totalSkipped })

  return { totalScanned, totalSent, totalSkipped }
}
