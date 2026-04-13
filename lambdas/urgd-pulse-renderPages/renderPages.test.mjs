// Unit tests for urgd-pulse-renderPages (Session Fast Start — Visual Document Rendering)
// Requirements: 4.1–4.5, 5.1–5.5
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET_NAME', 'urgd-pulse-data-dev')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSpy = vi.fn()
const s3Spy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSpy(...args) } }
  class UpdateItemCommand { constructor(input) { this.input = input; this.name = 'UpdateItemCommand' } }
  return { DynamoDBClient, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3Spy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input; this.name = 'GetObjectCommand' } }
  class PutObjectCommand { constructor(input) { this.input = input; this.name = 'PutObjectCommand' } }
  return { S3Client, GetObjectCommand, PutObjectCommand }
})

// Mock child_process execSync
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}))

// Mock fs functions
vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
  unlinkSync: vi.fn(),
}))

// Mock pdf-to-img as a dynamic import
vi.mock('pdf-to-img', () => {
  const pdfFn = vi.fn()
  return { pdf: pdfFn }
})

const { handler } = await import('./index.mjs')
const { pdf: pdfMock } = await import('pdf-to-img')
const { existsSync } = await import('fs')

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
    maxDocumentPages: 20,
    ...overrides,
  }
}

/**
 * Create a mock pdf-to-img document with async iteration.
 */
function makePdfDocument(pageCount) {
  const pages = Array.from({ length: pageCount }, (_, i) => Buffer.from(`page-${i + 1}`))
  return {
    length: pageCount,
    [Symbol.asyncIterator]: async function* () {
      for (const page of pages) yield page
    },
  }
}

// ── Tests ──

describe('urgd-pulse-renderPages', () => {
  beforeEach(() => {
    dynamoSpy.mockReset()
    s3Spy.mockReset()
    pdfMock.mockReset()
    existsSync.mockReturnValue(true)
  })

  it('renders PDF pages and writes pageCount to item record', async () => {
    // S3 GetObject returns document bytes
    s3Spy.mockResolvedValueOnce(makeS3Body('fake-pdf-bytes'))
    // pdf-to-img returns 3 pages
    pdfMock.mockResolvedValueOnce(makePdfDocument(3))
    // S3 PutObject for each page
    s3Spy.mockResolvedValueOnce({}) // page 1
    s3Spy.mockResolvedValueOnce({}) // page 2
    s3Spy.mockResolvedValueOnce({}) // page 3
    // DynamoDB UpdateItem for pageCount
    dynamoSpy.mockResolvedValueOnce({})

    await handler(makeEvent())

    // 3 pages uploaded + 1 S3 GetObject = 4 s3 calls
    expect(s3Spy).toHaveBeenCalledTimes(4)
    // pageCount written to item record
    expect(dynamoSpy).toHaveBeenCalledOnce()
    const updateCall = dynamoSpy.mock.calls[0][0]
    expect(updateCall.name).toBe('UpdateItemCommand')
    expect(updateCall.input.ExpressionAttributeValues[':pc'].N).toBe('3')
  })

  it('writes page_limit_exceeded + pageCountActual when page count exceeds limit', async () => {
    s3Spy.mockResolvedValueOnce(makeS3Body('fake-pdf-bytes'))
    // pdf-to-img returns 25 pages but limit is 20
    pdfMock.mockResolvedValueOnce(makePdfDocument(25))
    // DynamoDB UpdateItem for page_limit_exceeded
    dynamoSpy.mockResolvedValueOnce({})

    await handler(makeEvent({ maxDocumentPages: 20 }))

    expect(dynamoSpy).toHaveBeenCalledOnce()
    const updateCall = dynamoSpy.mock.calls[0][0]
    expect(updateCall.input.ExpressionAttributeValues[':status'].S).toBe('page_limit_exceeded')
    expect(updateCall.input.ExpressionAttributeValues[':actual'].N).toBe('25')
    // No page uploads should have happened (only 1 S3 call = GetObject)
    expect(s3Spy).toHaveBeenCalledTimes(1)
  })

  it('exits gracefully on S3 read failure', async () => {
    s3Spy.mockRejectedValueOnce(new Error('S3 access denied'))

    await handler(makeEvent())

    // No DynamoDB writes, no page uploads
    expect(dynamoSpy).not.toHaveBeenCalled()
    expect(pdfMock).not.toHaveBeenCalled()
  })

  it('skips individual page upload failure and continues with remaining pages', async () => {
    s3Spy.mockResolvedValueOnce(makeS3Body('fake-pdf-bytes'))
    pdfMock.mockResolvedValueOnce(makePdfDocument(3))
    // Page 1 upload succeeds
    s3Spy.mockResolvedValueOnce({})
    // Page 2 upload fails
    s3Spy.mockRejectedValueOnce(new Error('Upload failed'))
    // Page 3 upload succeeds
    s3Spy.mockResolvedValueOnce({})
    // DynamoDB UpdateItem for pageCount (2 successful)
    dynamoSpy.mockResolvedValueOnce({})

    await handler(makeEvent())

    // pageCount should be 2 (skipped the failed page)
    expect(dynamoSpy).toHaveBeenCalledOnce()
    const updateCall = dynamoSpy.mock.calls[0][0]
    expect(updateCall.input.ExpressionAttributeValues[':pc'].N).toBe('2')
  })

  it('exits gracefully with missing event fields', async () => {
    await handler({})
    expect(s3Spy).not.toHaveBeenCalled()
    expect(dynamoSpy).not.toHaveBeenCalled()
  })
})
