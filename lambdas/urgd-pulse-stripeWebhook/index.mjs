// ur/gd pulse — Stripe Webhook Lambda
// POST /api/webhooks/stripe
//
// Receives Stripe webhook events and updates tenant records accordingly.
// No Cognito auth — authentication via Stripe signature verification.
// Handles: invoice.paid, customer.subscription.deleted, customer.subscription.updated

import Stripe from 'stripe'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { getTierDefaults } from './shared/tiers.mjs'
import { log, requireEnv } from './shared/utils.mjs'

requireEnv(['TENANTS_TABLE', 'ALERTS_TOPIC_ARN', 'STRIPE_WEBHOOK_SECRET_PARAM'])

const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-west-2' })
const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const sns = new SNSClient({ region: process.env.AWS_REGION || 'us-west-2' })

// Cached SSM values — fetched once per cold start, reused across invocations
let cachedWebhookSecret = null
let cachedStripeSecretKey = null
let stripeInstance = null

/**
 * Fetch a SecureString SSM parameter (with caching).
 */
async function getSSMParam(paramName) {
  const result = await ssm.send(new GetParameterCommand({
    Name: paramName,
    WithDecryption: true,
  }))
  return result.Parameter.Value
}

/**
 * Get the webhook signing secret (cached after first call).
 */
async function getWebhookSecret() {
  if (!cachedWebhookSecret) {
    cachedWebhookSecret = await getSSMParam(process.env.STRIPE_WEBHOOK_SECRET_PARAM)
  }
  return cachedWebhookSecret
}

/**
 * Get an initialized Stripe SDK instance (cached after first call).
 * Uses STRIPE_SECRET_KEY_PARAM if set, otherwise derives from webhook secret param path.
 */
async function getStripeInstance() {
  if (!stripeInstance) {
    const secretKeyParam = process.env.STRIPE_SECRET_KEY_PARAM || '/pulse/stripe/secret-key'
    cachedStripeSecretKey = await getSSMParam(secretKeyParam)
    stripeInstance = new Stripe(cachedStripeSecretKey)
  }
  return stripeInstance
}

/**
 * Simple JSON response helper.
 */
function respond(statusCode, data = { received: true }) {
  return { statusCode, body: JSON.stringify(data) }
}

/**
 * Resolve tenantId from a Stripe Customer's metadata.
 * Retrieves the Customer object and reads metadata.tenantId.
 */
async function resolveTenantId(stripe, customerId, requestId) {
  const customer = await stripe.customers.retrieve(customerId)
  const tenantId = customer.metadata?.tenantId
  if (!tenantId) {
    log('error', 'Webhook: no tenantId in Stripe Customer metadata', {
      requestId, customerId,
    })
    await sns.send(new PublishCommand({
      TopicArn: process.env.ALERTS_TOPIC_ARN,
      Subject: 'Pulse: Stripe webhook — missing tenantId',
      Message: JSON.stringify({
        alert: 'stripe_webhook_missing_tenant',
        customerId,
        timestamp: new Date().toISOString(),
      }),
    })).catch(snsErr => {
      log('error', 'Webhook: SNS alert publish failed', { requestId, errorName: snsErr.name })
    })
    return null
  }
  return tenantId
}

/**
 * Check if this event should be skipped due to out-of-order delivery.
 * Returns the tenant item if processing should continue, null if skipped.
 */
async function getTenantAndCheckTimestamp(tenantId, eventCreated, requestId) {
  const result = await dynamo.send(new GetItemCommand({
    TableName: process.env.TENANTS_TABLE,
    Key: { tenantId: { S: tenantId } },
    ProjectionExpression: 'lastStripeEventTimestamp',
  }))

  const lastTs = result.Item?.lastStripeEventTimestamp?.N
  if (lastTs && eventCreated <= Number(lastTs)) {
    log('info', 'Webhook: skipping out-of-order event', {
      requestId, tenantId, eventCreated, lastStripeEventTimestamp: Number(lastTs),
    })
    return null
  }
  return result.Item || {}
}

/**
 * Build the DynamoDB attribute map for features from getTierDefaults output.
 */
function buildFeaturesMap(tierName) {
  const defaults = getTierDefaults(tierName)
  const featuresMap = {}
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === 'boolean') featuresMap[key] = { BOOL: value }
    else if (typeof value === 'number') featuresMap[key] = { N: String(value) }
  }
  return featuresMap
}

/**
 * Handle invoice.paid — upgrade tenant tier, apply features, zero counters.
 */
async function handleInvoicePaid(stripeEvent, stripe, requestId) {
  const invoice = stripeEvent.data.object
  const customerId = invoice.customer

  const tenantId = await resolveTenantId(stripe, customerId, requestId)
  if (!tenantId) return respond(200)

  const tenantItem = await getTenantAndCheckTimestamp(tenantId, stripeEvent.created, requestId)
  if (!tenantItem) return respond(200)

  // Read tier from subscription metadata — try line item metadata first, then subscription_details
  const newTier =
    invoice.lines?.data?.[0]?.metadata?.tier ||
    invoice.subscription_details?.metadata?.tier ||
    'free'

  const featuresMap = buildFeaturesMap(newTier)
  const now = new Date().toISOString()
  const today = now.slice(0, 10) // YYYY-MM-DD

  const zeroCounters = {
    monthlyItemsCreated: { M: { count: { N: '0' }, periodStart: { S: today } } },
    monthlySessionsTotal: { M: { count: { N: '0' }, periodStart: { S: today } } },
    monthlyPublicSessionsTotal: { M: { count: { N: '0' }, periodStart: { S: today } } },
  }

  await dynamo.send(new UpdateItemCommand({
    TableName: process.env.TENANTS_TABLE,
    Key: { tenantId: { S: tenantId } },
    UpdateExpression: 'SET tier = :tier, features = :features, usageCounters = :counters, lastStripeEventTimestamp = :ts, updatedAt = :now',
    ExpressionAttributeValues: {
      ':tier': { S: newTier },
      ':features': { M: featuresMap },
      ':counters': { M: zeroCounters },
      ':ts': { N: String(stripeEvent.created) },
      ':now': { S: now },
    },
  }))

  log('info', 'Webhook: invoice.paid processed', {
    requestId, tenantId, newTier, eventCreated: stripeEvent.created,
  })
  return respond(200)
}

/**
 * Handle customer.subscription.deleted — revert tenant to free tier.
 */
async function handleSubscriptionDeleted(stripeEvent, stripe, requestId) {
  const subscription = stripeEvent.data.object
  const customerId = subscription.customer

  const tenantId = await resolveTenantId(stripe, customerId, requestId)
  if (!tenantId) return respond(200)

  const tenantItem = await getTenantAndCheckTimestamp(tenantId, stripeEvent.created, requestId)
  if (!tenantItem) return respond(200)

  const featuresMap = buildFeaturesMap('free')
  const now = new Date().toISOString()

  await dynamo.send(new UpdateItemCommand({
    TableName: process.env.TENANTS_TABLE,
    Key: { tenantId: { S: tenantId } },
    UpdateExpression: 'SET tier = :tier, features = :features, lastStripeEventTimestamp = :ts, updatedAt = :now',
    ExpressionAttributeValues: {
      ':tier': { S: 'free' },
      ':features': { M: featuresMap },
      ':ts': { N: String(stripeEvent.created) },
      ':now': { S: now },
    },
  }))

  log('info', 'Webhook: customer.subscription.deleted processed', {
    requestId, tenantId, eventCreated: stripeEvent.created,
  })
  return respond(200)
}

/**
 * Handle customer.subscription.updated — update tier and features, do NOT reset counters.
 */
async function handleSubscriptionUpdated(stripeEvent, stripe, requestId) {
  const subscription = stripeEvent.data.object
  const customerId = subscription.customer

  const tenantId = await resolveTenantId(stripe, customerId, requestId)
  if (!tenantId) return respond(200)

  const tenantItem = await getTenantAndCheckTimestamp(tenantId, stripeEvent.created, requestId)
  if (!tenantItem) return respond(200)

  const newTier = subscription.metadata?.tier || 'free'
  const featuresMap = buildFeaturesMap(newTier)
  const now = new Date().toISOString()

  await dynamo.send(new UpdateItemCommand({
    TableName: process.env.TENANTS_TABLE,
    Key: { tenantId: { S: tenantId } },
    UpdateExpression: 'SET tier = :tier, features = :features, lastStripeEventTimestamp = :ts, updatedAt = :now',
    ExpressionAttributeValues: {
      ':tier': { S: newTier },
      ':features': { M: featuresMap },
      ':ts': { N: String(stripeEvent.created) },
      ':now': { S: now },
    },
  }))

  log('info', 'Webhook: customer.subscription.updated processed', {
    requestId, tenantId, newTier, eventCreated: stripeEvent.created,
  })
  return respond(200)
}

/**
 * Lambda handler — Stripe webhook entry point.
 */
export const handler = async (event) => {
  const requestId = event?.requestContext?.requestId

  try {
    // 1. Read raw body and Stripe-Signature header
    const body = event.body
    const signature = event.headers?.['Stripe-Signature'] || event.headers?.['stripe-signature']

    if (!body || !signature) {
      log('warn', 'Webhook: missing body or Stripe-Signature header', { requestId })
      return respond(400, { error: 'Missing body or signature' })
    }

    // 2. Fetch webhook secret from SSM (cached)
    let webhookSecret
    try {
      webhookSecret = await getWebhookSecret()
    } catch (ssmErr) {
      log('error', 'Webhook: failed to fetch webhook secret from SSM', {
        requestId, errorName: ssmErr.name,
      })
      return respond(500, { error: 'Internal configuration error' })
    }

    // 3. Verify signature
    let stripeEvent
    try {
      stripeEvent = Stripe.webhooks.constructEvent(body, signature, webhookSecret)
    } catch (sigErr) {
      log('warn', 'Webhook: invalid signature', { requestId, errorMessage: sigErr.message })
      return respond(400, { error: 'Invalid signature' })
    }

    log('info', 'Webhook: event received', {
      requestId, eventType: stripeEvent.type, eventId: stripeEvent.id,
    })

    // 4. Initialize Stripe SDK (cached)
    let stripe
    try {
      stripe = await getStripeInstance()
    } catch (ssmErr) {
      log('error', 'Webhook: failed to initialize Stripe SDK', {
        requestId, errorName: ssmErr.name,
      })
      return respond(500, { error: 'Internal configuration error' })
    }

    // 5. Route by event type
    switch (stripeEvent.type) {
      case 'invoice.paid':
        return await handleInvoicePaid(stripeEvent, stripe, requestId)

      case 'customer.subscription.deleted':
        return await handleSubscriptionDeleted(stripeEvent, stripe, requestId)

      case 'customer.subscription.updated':
        return await handleSubscriptionUpdated(stripeEvent, stripe, requestId)

      default:
        log('info', 'Webhook: unhandled event type, returning 200', {
          requestId, eventType: stripeEvent.type,
        })
        return respond(200)
    }
  } catch (err) {
    log('error', 'Webhook: unexpected error', {
      requestId, errorName: err.name, errorMessage: err.message,
    })
    return respond(500, { error: 'Internal server error' })
  }
}
