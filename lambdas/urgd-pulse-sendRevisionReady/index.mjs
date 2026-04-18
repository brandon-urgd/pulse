// ur/gd pulse — Send Revision Ready Lambda
// Invoked async by processRevision when a revision completes successfully.
// Sends "Your revision is ready" email to the tenant via SES.
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

/**
 * Builds the revision-ready email content (subject, HTML body, plain-text body).
 * Exported for testability (Property 3).
 *
 * @param {string} itemName - The name of the item
 * @param {string} itemId - The item ID (used in the revisions URL)
 * @param {string} appUrl - The base app URL (e.g. https://pulse.urgdstudios.com)
 * @returns {{ subject: string, htmlBody: string, textBody: string }}
 */
export function buildRevisionReadyEmail(itemName, itemId, appUrl) {
  const revisionsUrl = `${appUrl}/admin/items/${itemId}/revisions`
  const subject = `Your revision for ${itemName} is ready`

  const textBody = [
    `Great news — your revision for ${itemName} is ready.`,
    '',
    `Pulse has taken the accepted and revised feedback from your Pulse Check and produced a revision you can review and apply.`,
    '',
    `View your revision: ${revisionsUrl}`,
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
  <title>Your revision is ready</title>
</head>
<body style="max-width:600px;margin:0 auto;padding:24px;color:#111827;font-family:'Rubik',sans-serif;background:#ffffff;">

  <!-- Heading -->
  <h2 style="font-family:'Archivo',sans-serif;font-size:22px;font-weight:700;color:#111827;margin:0 0 16px;">Your revision is ready.</h2>

  <!-- Body copy -->
  <p style="font-size:16px;line-height:1.6;color:#111827;margin:0 0 12px;">
    Great news — your revision for ${itemName} is ready.
  </p>
  <p style="font-size:16px;line-height:1.6;color:#111827;margin:0 0 28px;">
    Pulse has taken the accepted and revised feedback from your Pulse Check and produced a revision you can review and apply.
  </p>

  <!-- CTA Button -->
  <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
    <tr>
      <td style="background-color:#7a9e87;border-radius:8px;padding:12px 24px;">
        <a href="${revisionsUrl}"
           style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;font-family:'Rubik',sans-serif;">
          View your revision
        </a>
      </td>
    </tr>
  </table>

  <p style="font-size:13px;color:#4b5563;margin:0 0 28px;">
    Or copy this link: <a href="${revisionsUrl}" style="color:#7a9e87;">${revisionsUrl}</a>
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

  return { subject, htmlBody, textBody }
}

export const handler = async (event) => {
  const { tenantId, itemId, itemName, revisionId } = event

  if (!tenantId || !itemId || !itemName || !revisionId) {
    log('error', 'SendRevisionReady: missing required fields', { tenantId, itemId, revisionId })
    return
  }

  log('info', 'SendRevisionReady: starting', { tenantId, itemId, revisionId })

  try {
    // 1. Look up tenant email from DynamoDB
    const tenantResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
      ProjectionExpression: 'email',
    }))

    if (!tenantResult.Item) {
      log('error', 'SendRevisionReady: tenant not found', { tenantId, itemId })
      return
    }

    const tenantEmail = tenantResult.Item.email?.S
    if (!tenantEmail) {
      log('error', 'SendRevisionReady: tenant has no email', { tenantId, itemId })
      return
    }

    // 2. Build email content
    const appUrl = process.env.APP_URL ?? 'https://pulse.urgdstudios.com'
    const { subject, htmlBody, textBody } = buildRevisionReadyEmail(itemName, itemId, appUrl)

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
      log('info', 'SendRevisionReady: email sent', { tenantId, itemId, revisionId })
    } catch (sesErr) {
      log('error', 'SendRevisionReady: SES send failed', { tenantId, itemId, revisionId, errorName: sesErr.name })

      // Publish alert to SNS on SES failure
      try {
        await sns.send(new PublishCommand({
          TopicArn: process.env.ALERTS_TOPIC_ARN,
          Subject: 'Pulse: Revision ready email delivery failure',
          Message: JSON.stringify({
            alert: 'ses_revision_ready_failure',
            tenantId,
            itemId,
            revisionId,
            timestamp: new Date().toISOString(),
          }),
        }))
      } catch (snsErr) {
        log('error', 'SendRevisionReady: SNS alert publish failed', { tenantId, itemId, revisionId, errorName: snsErr.name })
      }
    }
  } catch (err) {
    log('error', 'SendRevisionReady: unexpected error', { tenantId, itemId, revisionId, errorName: err.name })
  }
}
