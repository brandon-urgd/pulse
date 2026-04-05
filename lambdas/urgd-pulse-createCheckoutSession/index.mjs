// ur/gd pulse — Create Checkout Session Lambda
// POST /api/manage/checkout → creates Stripe Checkout or Billing Portal session

import Stripe from 'stripe'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv([
  'TENANTS_TABLE',
  'STRIPE_SECRET_KEY_PARAM',
  'STRIPE_PRICE_INDIVIDUAL_PARAM',
  'STRIPE_PRICE_PRO_PARAM',
  'STRIPE_PRICE_ENTERPRISE_PARAM',
  'PLAN_PAGE_URL',
  'CORS_ALLOWED_ORIGINS',
])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-west-2' })

// --- SSM caching (module-level, survives across warm invocations) ---

let cachedStripeKey = null
async function getStripeKey() {
  if (cachedStripeKey) return cachedStripeKey
  const result = await ssm.send(new GetParameterCommand({
    Name: process.env.STRIPE_SECRET_KEY_PARAM,
    WithDecryption: true,
  }))
  cachedStripeKey = result.Parameter.Value
  return cachedStripeKey
}

const PRICE_PARAM_MAP = {
  individual: 'STRIPE_PRICE_INDIVIDUAL_PARAM',
  pro: 'STRIPE_PRICE_PRO_PARAM',
  enterprise: 'STRIPE_PRICE_ENTERPRISE_PARAM',
}
const VALID_PRICE_IDS = Object.keys(PRICE_PARAM_MAP)

const cachedPriceIds = {}
async function getStripePriceId(priceId) {
  if (cachedPriceIds[priceId]) return cachedPriceIds[priceId]
  const paramName = process.env[PRICE_PARAM_MAP[priceId]]
  const result = await ssm.send(new GetParameterCommand({
    Name: paramName,
    WithDecryption: false,
  }))
  cachedPriceIds[priceId] = result.Parameter.Value
  return cachedPriceIds[priceId]
}

// --- Handler ---

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId

  if (!tenantId) {
    log('warn', 'CreateCheckoutSession: missing tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  let body
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body ?? {}
  } catch {
    return errorResponse(400, 'Invalid JSON body', {}, origin)
  }

  const { action, priceId } = body

  // Validate action
  if (!action || !['checkout', 'portal'].includes(action)) {
    log('warn', 'CreateCheckoutSession: invalid or missing action', { requestId, tenantId, action })
    return errorResponse(400, 'Missing or invalid action. Must be "checkout" or "portal".', {}, origin)
  }

  // Validate priceId for checkout action
  if (action === 'checkout' && (!priceId || !VALID_PRICE_IDS.includes(priceId))) {
    log('warn', 'CreateCheckoutSession: invalid or missing priceId', { requestId, tenantId, priceId })
    return errorResponse(400, 'Missing or invalid priceId. Must be "individual", "pro", or "enterprise".', {}, origin)
  }

  try {
    // Fetch tenant record to get stripeCustomerId
    const tenantResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
      ProjectionExpression: 'stripeCustomerId',
    }))

    const stripeCustomerId = tenantResult.Item?.stripeCustomerId?.S ?? null

    if (!stripeCustomerId) {
      log('warn', 'CreateCheckoutSession: tenant has no stripeCustomerId', { requestId, tenantId })
      return errorResponse(400, 'No Stripe customer on file', { reason: 'no_stripe_customer' }, origin)
    }

    // Fetch Stripe secret key from SSM (cached)
    const stripeKey = await getStripeKey()
    const stripe = new Stripe(stripeKey)

    if (action === 'checkout') {
      // Fetch the corresponding Stripe Price ID from SSM (cached)
      const stripePriceId = await getStripePriceId(priceId)

      log('info', 'CreateCheckoutSession: creating checkout session', { requestId, tenantId, priceId })

      const session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        mode: 'subscription',
        line_items: [{ price: stripePriceId, quantity: 1 }],
        subscription_data: { metadata: { tier: priceId, tenantId } },
        success_url: `${process.env.PLAN_PAGE_URL}?upgraded=true`,
        cancel_url: process.env.PLAN_PAGE_URL,
      })

      return createResponse(200, { data: { url: session.url } }, {}, origin)
    }

    if (action === 'portal') {
      log('info', 'CreateCheckoutSession: creating portal session', { requestId, tenantId })

      const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: process.env.PLAN_PAGE_URL,
      })

      return createResponse(200, { data: { url: session.url } }, {}, origin)
    }
  } catch (err) {
    log('error', 'CreateCheckoutSession: unexpected error', {
      requestId,
      tenantId,
      action,
      errorName: err.name,
      errorMessage: err.message,
    })
    return errorResponse(500, 'Failed to create session', {}, origin)
  }
}
