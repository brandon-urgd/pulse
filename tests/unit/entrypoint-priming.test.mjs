// Unit tests for entry point Lambda priming integration
// Validates: Requirements 1.1, 1.4, 9.1, 9.2
// Tests: 2.5 fire-and-forget timing, 2.6 image items skipped, 2.7 no native doc skipped
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Stub env vars before any imports
vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')
vi.stubEnv('AWS_REGION', 'us-west-2')
vi.stubEnv('APP_URL', 'https://pulse.urgdstudios.com')
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const bedrockSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input; this.name = 'GetItemCommand' } }
  class QueryCommand { constructor(input) { this.input = input; this.name = 'QueryCommand' } }
  class PutItemCommand { constructor(input) { this.input = input; this.name = 'PutItemCommand' } }
  class UpdateItemCommand { constructor(input) { this.input = input; this.name = 'UpdateItemCommand' } }
  class TransactWriteItemsCommand { constructor(input) { this.input = input; this.name = 'TransactWriteItemsCommand' } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, PutItemCommand, UpdateItemCommand, TransactWriteItemsCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3SendSpy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send(...args) { return bedrockSendSpy(...args) } }
  class ConverseCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, ConverseCommand }
})

// --- Helpers ---

function makeValidateEvent(body) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: { requestId: 'req-test' },
    body: JSON.stringify(body),
  }
}

function makeCreateSelfEvent(itemId) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { tenantId: 'tenant-1' },
    },
    pathParameters: { itemId },
    body: '{}',
  }
}

function makeSessionRecord(overrides = {}) {
  return {
    tenantId: { S: 'tenant-1' },
    sessionId: { S: 'session-1' },
    itemId: { S: 'item-1' },
    status: { S: 'not_started' },
    timeLimitMinutes: { N: '30' },
    reviewerEmail: { S: 'test@example.com' },
    ...overrides,
  }
}

function makeDocumentItem(overrides = {}) {
  return {
    tenantId: { S: 'tenant-1' },
    itemId: { S: 'item-1' },
    itemName: { S: 'Test Document' },
    description: { S: 'A test document' },
    itemType: { S: 'document' },
    documentKey: { S: 'pulse/tenant-1/items/item-1/document.pdf' },
    pageCount: { N: '2' },
    status: { S: 'active' },
    ...overrides,
  }
}

function makeImageItem(overrides = {}) {
  return {
    tenantId: { S: 'tenant-1' },
    itemId: { S: 'item-1' },
    itemName: { S: 'Test Image' },
    description: { S: 'A test image' },
    itemType: { S: 'image' },
    status: { S: 'active' },
    ...overrides,
  }
}

function makeMarkdownItem(overrides = {}) {
  return {
    tenantId: { S: 'tenant-1' },
    itemId: { S: 'item-1' },
    itemName: { S: 'Test Markdown' },
    description: { S: 'A test markdown item' },
    itemType: { S: 'document' },
    // No documentKey — text-only item
    status: { S: 'active' },
    ...overrides,
  }
}

function fakeS3Body(buf) {
  return {
    Body: {
      async *[Symbol.asyncIterator]() { yield buf },
    },
  }
}

const FAKE_PDF_BYTES = Buffer.from('%PDF-1.4 fake')
const FAKE_PAGE_BYTES = Buffer.from('fake-png')

function setupS3ForDocument() {
  s3SendSpy.mockImplementation((cmd) => {
    const key = cmd.input?.Key || ''
    if (key.endsWith('.pdf')) return Promise.resolve(fakeS3Body(FAKE_PDF_BYTES))
    if (key.includes('/pages/page-')) return Promise.resolve(fakeS3Body(FAKE_PAGE_BYTES))
    return Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
  })
}

// --- Tests ---

describe('Entry point Lambda priming — validateSession', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    s3SendSpy.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
  })

  // 2.5: Fire-and-forget — response returns before priming completes
  it('returns response before priming completes (fire-and-forget)', async () => {
    // DynamoDB calls for validateSession:
    // 1. QueryCommand — look up session by pulseCode
    // 2. GetItemCommand — load item record
    dynamoSendSpy
      .mockResolvedValueOnce({ Items: [makeSessionRecord()] })  // Query session by pulseCode
      .mockResolvedValueOnce({ Item: makeDocumentItem() })       // GetItem item record

    setupS3ForDocument()

    // Bedrock priming call with a 500ms delay to simulate slow priming
    let primingResolved = false
    bedrockSendSpy.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => {
        primingResolved = true
        resolve({
          output: { message: { content: [{ text: '' }] } },
          usage: { inputTokens: 5000, outputTokens: 1, cacheWriteInputTokens: 4800, cacheReadInputTokens: 0 },
        })
      }, 500)
    }))

    const { handler } = await import('../../lambdas/urgd-pulse-validateSession/index.mjs')

    const event = makeValidateEvent({ pulseCode: 'ABCD1234', email: 'test@example.com' })
    const result = await handler(event)

    // Response should be returned immediately — before priming completes
    expect(result.statusCode).toBe(200)
    expect(primingResolved).toBe(false)

    // Give the fire-and-forget priming a tick to start
    await new Promise(resolve => setTimeout(resolve, 50))

    // Verify S3 was called (priming started loading document)
    expect(s3SendSpy).toHaveBeenCalled()

    // Verify Bedrock was called (priming was initiated)
    // Note: bedrockSendSpy may not be called yet if S3 calls are still resolving
    // Wait for priming to complete in background
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(primingResolved).toBe(true)
    expect(bedrockSendSpy).toHaveBeenCalledTimes(1)
  })

  // 2.6: Priming is skipped for image items
  it('skips priming for image items', async () => {
    dynamoSendSpy
      .mockResolvedValueOnce({ Items: [makeSessionRecord()] })  // Query session by pulseCode
      .mockResolvedValueOnce({ Item: makeImageItem() })          // GetItem item record (image)

    const { handler } = await import('../../lambdas/urgd-pulse-validateSession/index.mjs')

    const event = makeValidateEvent({ pulseCode: 'ABCD1234', email: 'test@example.com' })
    const result = await handler(event)

    expect(result.statusCode).toBe(200)

    // Bedrock should NOT be called — image items are not eligible for priming
    expect(bedrockSendSpy).not.toHaveBeenCalled()
  })
})

describe('Entry point Lambda priming — createSelfSession', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    s3SendSpy.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
  })

  // 2.7: Priming is skipped for items without native document
  it('skips priming for items without native document', async () => {
    // DynamoDB calls for createSelfSession:
    // 1. GetItemCommand — load item record
    // 2. QueryCommand — check existing self-review sessions (item-index)
    // 3. QueryCommand — count all sessions for limit check (item-index)
    // 4. GetItemCommand — fetch tenant record
    // 5. GetItemCommand — fetch SYSTEM record
    // 6. PutItemCommand — create session
    // 7. UpdateItemCommand — update item sessionCount
    // (plus checkAndIncrement calls)
    dynamoSendSpy
      .mockResolvedValueOnce({ Item: makeMarkdownItem() })       // GetItem item record (no documentKey)
      .mockResolvedValueOnce({ Items: [] })                       // Query existing self-review sessions
      .mockResolvedValueOnce({ Count: 0 })                        // Query all sessions count
      .mockResolvedValueOnce({                                     // GetItem tenant record
        Item: {
          tenantId: { S: 'tenant-1' },
          tier: { S: 'pro' },
          features: { M: {} },
          serviceFlags: { M: {} },
        },
      })
      .mockResolvedValueOnce({ Item: null })                      // GetItem SYSTEM record
      .mockResolvedValueOnce({})                                   // checkAndIncrement — GetItem counter
      .mockResolvedValueOnce({})                                   // checkAndIncrement — UpdateItem counter
      .mockResolvedValueOnce({})                                   // PutItem session
      .mockResolvedValueOnce({})                                   // UpdateItem item sessionCount

    const { handler } = await import('../../lambdas/urgd-pulse-createSelfSession/index.mjs')

    const event = makeCreateSelfEvent('item-1')
    const result = await handler(event)

    expect(result.statusCode).toBe(201)

    // Bedrock should NOT be called — no native document available
    expect(bedrockSendSpy).not.toHaveBeenCalled()
  })
})
