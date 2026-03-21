// ur/gd pulse — Send Pulse Check Ready Lambda
// Invoked async by expireSessions when all sessions for an item are closed.
// Sends "Your Pulse Check is ready" email to the tenant via SES.
// On SES failure, publishes alert to ALERTS_TOPIC_ARN.
// Structured logging — no PII (log tenantId and itemId only).

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { log, requireEnv } from './shared/utils.mjs'

requireEnv(['TENANTS_TABLE', 'ALERTS_TOPIC_ARN', 'APP_URL'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const ses = new SESClient({ region: process.env.AWS_REGION || 'us-west-2' })
const sns = new SNSClient({ region: process.env.AWS_REGION || 'us-west-2' })

const FROM_ADDRESS = 'Pulse <pulse@urgdstudios.com>'
const REPLY_TO = 'admin@urgdstudios.com'

export const handler = async (event) => {
  const { tenantId, itemId, itemName } = event

  if (!tenantId || !itemId || !itemName) {
    log('error', 'SendPulseCheckReady: missing required fields', { tenantId, itemId })
    return
  }

  log('info', 'SendPulseCheckReady: starting', { tenantId, itemId })

  try {
    // 1. Look up tenant email from DynamoDB
    const tenantResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
      ProjectionExpression: 'email',
    }))

    if (!tenantResult.Item) {
      log('error', 'SendPulseCheckReady: tenant not found', { tenantId, itemId })
      return
    }

    const tenantEmail = tenantResult.Item.email?.S
    if (!tenantEmail) {
      log('error', 'SendPulseCheckReady: tenant has no email', { tenantId, itemId })
      return
    }

    // 2. Build email content
    const appUrl = process.env.APP_URL ?? 'https://pulse.urgdstudios.com'
    const pulseCheckUrl = `${appUrl}/admin/items/${itemId}/pulse-check`
    const subject = `Your Pulse Check for ${itemName} is ready`

    const textBody = [
      `${itemName} has closed, and Pulse has already done the work.`,
      '',
      `Your Pulse Check is waiting for you — a clear read on what your reviewers actually think, organized by signal.`,
      '',
      `View your Pulse Check: ${pulseCheckUrl}`,
      '',
      '---',
      'Sent by Pulse, powered by ur/gd Studios (https://www.urgdstudios.com)',
      'ur/gd Studios LLC · The Cloud Room · 1424 11th Ave STE 400 · Seattle, WA 98122-4271',
      'Privacy Policy: https://www.urgdstudios.com/privacy | Terms: https://www.urgdstudios.com/terms',
    ].join('\n')

    const htmlBody = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Your Pulse Check is ready</title>
</head>
<body style="max-width:600px;margin:0 auto;padding:24px;color:#111827;font-family:'Rubik',sans-serif;background:#ffffff;">

  <!-- Heading -->
  <h2 style="font-family:'Archivo',sans-serif;font-size:22px;font-weight:700;color:#111827;margin:0 0 16px;">Your Pulse Check is ready.</h2>

  <!-- Body copy -->
  <p style="font-size:16px;line-height:1.6;color:#111827;margin:0 0 12px;">
    ${itemName} has closed, and Pulse has already done the work.
  </p>
  <p style="font-size:16px;line-height:1.6;color:#111827;margin:0 0 28px;">
    Your Pulse Check is waiting for you — a clear read on what your reviewers actually think, organized by signal.
  </p>

  <!-- CTA Button -->
  <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
    <tr>
      <td style="background-color:#4f46e5;border-radius:8px;padding:12px 24px;">
        <a href="${pulseCheckUrl}"
           style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;font-family:'Rubik',sans-serif;">
          View your Pulse Check
        </a>
      </td>
    </tr>
  </table>

  <p style="font-size:13px;color:#4b5563;margin:0 0 28px;">
    Or copy this link: <a href="${pulseCheckUrl}" style="color:#4f46e5;">${pulseCheckUrl}</a>
  </p>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 16px;">

  <!-- Footer -->
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

    // 3. Send email via SES
    try {
      await ses.send(new SendEmailCommand({
        Source: FROM_ADDRESS,
        Destination: { ToAddresses: [tenantEmail] },
        ReplyToAddresses: [REPLY_TO],
        Message: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: textBody, Charset: 'UTF-8' },
            Html: { Data: htmlBody, Charset: 'UTF-8' },
          },
        },
      }))
      log('info', 'SendPulseCheckReady: email sent', { tenantId, itemId })
    } catch (sesErr) {
      log('error', 'SendPulseCheckReady: SES send failed', { tenantId, itemId, errorName: sesErr.name })

      // Publish alert to SNS on SES failure
      try {
        await sns.send(new PublishCommand({
          TopicArn: process.env.ALERTS_TOPIC_ARN,
          Subject: 'Pulse: Pulse Check ready email delivery failure',
          Message: JSON.stringify({
            alert: 'ses_pulse_check_ready_failure',
            tenantId,
            itemId,
            timestamp: new Date().toISOString(),
          }),
        }))
      } catch (snsErr) {
        log('error', 'SendPulseCheckReady: SNS alert publish failed', { tenantId, itemId, errorName: snsErr.name })
      }
    }
  } catch (err) {
    log('error', 'SendPulseCheckReady: unexpected error', { tenantId, itemId, errorName: err.name })
  }
}
