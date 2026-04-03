// ur/gd pulse — Email Session Summary Lambda
// POST /api/session/{sessionId}/email-summary
// Sends a session summary to a reviewer via SES
// CRITICAL: Does NOT store the email in DynamoDB, does NOT log the email address
// The email is passed directly to SES and not persisted anywhere

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['SESSIONS_TABLE', 'SES_FROM_EMAIL', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const ses = new SESClient({ region: process.env.AWS_REGION || 'us-west-2' })

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const sessionId = event?.requestContext?.authorizer?.sessionId
  const tenantId = event?.requestContext?.authorizer?.tenantId

  if (!sessionId || !tenantId) {
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  // Parse email from request body
  let email
  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body
    email = body?.email
  } catch {
    return errorResponse(400, 'Invalid request body', {}, origin)
  }

  if (!email || typeof email !== 'string') {
    return errorResponse(400, 'Missing email address', {}, origin)
  }

  if (!EMAIL_REGEX.test(email)) {
    return errorResponse(400, 'Invalid email address', {}, origin)
  }

  try {
    // 1. Get session record
    const sessionResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
    }))

    if (!sessionResult.Item) {
      return errorResponse(404, 'Session not found', {}, origin)
    }

    const session = sessionResult.Item

    // 2. Check for summary data
    const summaryRaw = session.summary?.S
    if (!summaryRaw) {
      return errorResponse(400, 'Session summary not yet generated', {}, origin)
    }

    let summary
    try {
      summary = JSON.parse(summaryRaw)
    } catch {
      return errorResponse(400, 'Session summary not yet generated', {}, origin)
    }

    // 3. Build HTML email body
    const itemName = session.itemName?.S ?? 'your item'
    const htmlBody = buildSummaryEmailHtml(summary, itemName)
    const textBody = buildSummaryEmailText(summary, itemName)

    // 4. Send email via SES — email is NOT logged, NOT stored
    await ses.send(new SendEmailCommand({
      Source: process.env.SES_FROM_EMAIL,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: 'Your Pulse Session Summary', Charset: 'UTF-8' },
        Body: {
          Text: { Data: textBody, Charset: 'UTF-8' },
          Html: { Data: htmlBody, Charset: 'UTF-8' },
        },
      },
    }))

    // Log success WITHOUT the email address (PII protection)
    log('info', 'EmailSessionSummary: email sent', { sessionId, tenantId })

    return createResponse(200, { data: { sent: true } }, {}, origin)
  } catch (err) {
    log('error', 'EmailSessionSummary: unexpected error', { sessionId, tenantId, errorName: err.name })
    return errorResponse(500, 'Failed to send email. Please try again.', {}, origin)
  }
}

/**
 * Builds an HTML email body from the session summary data.
 */
function buildSummaryEmailHtml(summary, itemName) {
  const sections = Array.isArray(summary.sections) ? summary.sections : []
  const themes = Array.isArray(summary.themes) ? summary.themes : []
  const closingMessage = typeof summary.closingMessage === 'string' ? summary.closingMessage : ''

  const sectionsHtml = sections.length > 0
    ? `<h3 style="color: #333; margin-top: 24px;">Sections Covered</h3>
       <ul>${sections.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`
    : ''

  const themesHtml = themes.length > 0
    ? `<h3 style="color: #333; margin-top: 24px;">Key Themes</h3>
       <ul>${themes.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
    : ''

  const closingHtml = closingMessage
    ? `<p style="margin-top: 24px; color: #555; font-style: italic;">${escapeHtml(closingMessage)}</p>`
    : ''

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <h2 style="color: #1a1a1a;">Your Pulse Session Summary</h2>
  <p style="color: #555;">Here's a summary of your feedback session for <strong>${escapeHtml(itemName)}</strong>.</p>
  ${sectionsHtml}
  ${themesHtml}
  ${closingHtml}
  <hr style="border: none; border-top: 1px solid #eee; margin-top: 32px;">
  <p style="font-size: 12px; color: #999;">This email was sent by Pulse by ur/gd Studios.</p>
</body>
</html>`
}

/**
 * Builds a plain text email body from the session summary data.
 */
function buildSummaryEmailText(summary, itemName) {
  const sections = Array.isArray(summary.sections) ? summary.sections : []
  const themes = Array.isArray(summary.themes) ? summary.themes : []
  const closingMessage = typeof summary.closingMessage === 'string' ? summary.closingMessage : ''

  let text = `Your Pulse Session Summary\n\nHere's a summary of your feedback session for ${itemName}.\n`

  if (sections.length > 0) {
    text += `\nSections Covered:\n${sections.map(s => `  - ${s}`).join('\n')}\n`
  }

  if (themes.length > 0) {
    text += `\nKey Themes:\n${themes.map(t => `  - ${t}`).join('\n')}\n`
  }

  if (closingMessage) {
    text += `\n${closingMessage}\n`
  }

  text += '\n---\nThis email was sent by Pulse by ur/gd Studios.'
  return text
}

/**
 * Basic HTML escaping to prevent XSS in email content.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
