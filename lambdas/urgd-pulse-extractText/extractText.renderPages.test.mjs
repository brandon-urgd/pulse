// Unit tests for urgd-pulse-extractText — RenderPages invocation
// Requirements: 4.1, 5.1, 8.1, 8.2, 10.1
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET_NAME', 'urgd-pulse-data-dev')
vi.stubEnv('ANALYZE_DOCUMENT_FUNCTION_ARN', 'arn:aws:lambda:us-west-2:123456789:function:urgd-pulse-analyzeDocument-dev')
vi.stubEnv('RENDER_PAGES_FUNCTION_ARN', 'arn:aws:lambda:us-west-2:123456789:function:urgd-pulse-renderPages-dev')
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSpy = vi.fn()
const s3Spy = vi.fn()
const lambdaSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input; this.name = 'GetItemCommand' } }
  class UpdateItemCommand { constructor(input) { this.input = input; this.name = 'UpdateItemCommand' } }
  return { DynamoDBClient, GetItemCommand, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3Spy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input; this.name = 'GetObjectCommand' } }
  class PutObjectCommand { constructor(input) { this.input = input; this.name = 'PutObjectCommand' } }
  return { S3Client, GetObjectCommand, PutObjectCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send(...args) { return lambdaSpy(...args) } }
  class InvokeCommand { constructor(input) { this.input = input; this.name = 'InvokeCommand' } }
  return { LambdaClient, InvokeCommand }
})

vi.mock('./shared/utils.mjs', () => ({
  log: vi.fn(),
  requireEnv: vi.fn(),
  unmarshalFeatures: vi.fn(() => ({})),
}))

vi.mock('./shared/features.mjs', () => ({
  resolveFeature: vi.fn(() => ({ allowed: true, limit: 20 })),
}))

// Mock pdf-parse as a dynamic import
vi.mock('pdf-parse', () => ({
  default: vi.fn(() => Promise.resolve({ text: 'Extracted PDF text content for testing', numpages: 5 })),
}))

// Mock mammoth as a dynamic import
vi.mock('mammoth', () => ({
  extractRawText: vi.fn(() => Promise.resolve({ value: 'Extracted DOCX text content for testing' })),
}))

const { handler } = await import('./index.mjs')

// ── Helpers ──

function makeS3Body(content) {
  return {
    Body: (async function* () { yield Buffer.from(content) })(),
  }
}

function makeEvent(overrides = {}) {
  return {
    tenantId: 'tenant-abc',
    itemId: 'item-123',
    key: 'pulse/tenant-abc/items/item-123/document.pdf',
    bucket: 'urgd-pulse-data-dev',
    ...overrides,
  }
}

function makeTenantRecord() {
  return { Item: { tenantId: { S: 'tenant-abc' }, tier: { S: 'pro' } } }
}

function makeSystemRecord() {
  return { Item: { tenantId: { S: 'SYSTEM' } } }
}

// ── Tests ──

describe('extractText — RenderPages invocation', () => {
  beforeEach(() => {
    dynamoSpy.mockReset()
    s3Spy.mockReset()
    lambdaSpy.mockReset()
  })

  it('invokes RenderPages for PDF files', async () => {
    // S3 GetObject returns PDF bytes
    s3Spy.mockResolvedValueOnce(makeS3Body('fake-pdf-bytes'))
    // S3 PutObject for extracted.md
    s3Spy.mockResolvedValueOnce({})
    // DynamoDB UpdateItem for documentStatus=ready
    dynamoSpy.mockResolvedValueOnce({})
    // Tenant + SYSTEM records for maxDocumentPages check (first call in PDF path)
    dynamoSpy.mockResolvedValueOnce(makeTenantRecord())
    dynamoSpy.mockResolvedValueOnce(makeSystemRecord())
    // analyzeDocument invoke
    lambdaSpy.mockResolvedValueOnce({})
    // Tenant + SYSTEM records for renderPages maxDocumentPages resolution
    dynamoSpy.mockResolvedValueOnce(makeTenantRecord())
    dynamoSpy.mockResolvedValueOnce(makeSystemRecord())
    // renderPages invoke
    lambdaSpy.mockResolvedValueOnce({})

    await handler(makeEvent())

    // Find the renderPages invoke call
    const renderPagesCall = lambdaSpy.mock.calls.find(
      ([cmd]) => cmd.input.FunctionName === 'arn:aws:lambda:us-west-2:123456789:function:urgd-pulse-renderPages-dev'
    )
    expect(renderPagesCall).toBeDefined()
    const payload = JSON.parse(renderPagesCall[0].input.Payload)
    expect(payload.tenantId).toBe('tenant-abc')
    expect(payload.itemId).toBe('item-123')
    expect(payload.maxDocumentPages).toBe(20)
  })

  it('invokes RenderPages for DOCX files', async () => {
    s3Spy.mockResolvedValueOnce(makeS3Body('fake-docx-bytes'))
    s3Spy.mockResolvedValueOnce({})
    dynamoSpy.mockResolvedValueOnce({})
    lambdaSpy.mockResolvedValueOnce({})
    dynamoSpy.mockResolvedValueOnce(makeTenantRecord())
    dynamoSpy.mockResolvedValueOnce(makeSystemRecord())
    lambdaSpy.mockResolvedValueOnce({})

    await handler(makeEvent({ key: 'pulse/tenant-abc/items/item-123/document.docx' }))

    const renderPagesCall = lambdaSpy.mock.calls.find(
      ([cmd]) => cmd.input.FunctionName === 'arn:aws:lambda:us-west-2:123456789:function:urgd-pulse-renderPages-dev'
    )
    expect(renderPagesCall).toBeDefined()
  })

  it('does NOT invoke RenderPages for .md files', async () => {
    // .md is unsupported — handler returns early with extraction_failed
    dynamoSpy.mockResolvedValueOnce({}) // UpdateItem extraction_failed

    await handler(makeEvent({ key: 'pulse/tenant-abc/items/item-123/document.md' }))

    // No renderPages invocation
    const renderPagesCall = lambdaSpy.mock.calls.find(
      ([cmd]) => cmd.input?.FunctionName?.includes('renderPages')
    )
    expect(renderPagesCall).toBeUndefined()
  })

  it('passes maxDocumentPages in RenderPages payload', async () => {
    s3Spy.mockResolvedValueOnce(makeS3Body('fake-pdf-bytes'))
    s3Spy.mockResolvedValueOnce({})
    dynamoSpy.mockResolvedValueOnce({})
    dynamoSpy.mockResolvedValueOnce(makeTenantRecord())
    dynamoSpy.mockResolvedValueOnce(makeSystemRecord())
    lambdaSpy.mockResolvedValueOnce({})
    dynamoSpy.mockResolvedValueOnce(makeTenantRecord())
    dynamoSpy.mockResolvedValueOnce(makeSystemRecord())
    lambdaSpy.mockResolvedValueOnce({})

    await handler(makeEvent())

    const renderPagesCall = lambdaSpy.mock.calls.find(
      ([cmd]) => cmd.input.FunctionName?.includes('renderPages')
    )
    expect(renderPagesCall).toBeDefined()
    const payload = JSON.parse(renderPagesCall[0].input.Payload)
    expect(payload).toHaveProperty('maxDocumentPages')
    expect(typeof payload.maxDocumentPages).toBe('number')
  })

  it('RenderPages invocation failure does not affect extraction', async () => {
    s3Spy.mockResolvedValueOnce(makeS3Body('fake-pdf-bytes'))
    s3Spy.mockResolvedValueOnce({})
    dynamoSpy.mockResolvedValueOnce({})
    dynamoSpy.mockResolvedValueOnce(makeTenantRecord())
    dynamoSpy.mockResolvedValueOnce(makeSystemRecord())
    // analyzeDocument succeeds
    lambdaSpy.mockResolvedValueOnce({})
    dynamoSpy.mockResolvedValueOnce(makeTenantRecord())
    dynamoSpy.mockResolvedValueOnce(makeSystemRecord())
    // renderPages fails
    lambdaSpy.mockRejectedValueOnce(new Error('Lambda invoke failed'))

    // Should not throw — extraction completes normally
    await handler(makeEvent())

    // documentStatus was set to ready (the UpdateItem call)
    const updateCall = dynamoSpy.mock.calls.find(
      ([cmd]) => cmd.name === 'UpdateItemCommand' &&
                 cmd.input.ExpressionAttributeValues?.[':status']?.S === 'ready'
    )
    expect(updateCall).toBeDefined()
  })
})
