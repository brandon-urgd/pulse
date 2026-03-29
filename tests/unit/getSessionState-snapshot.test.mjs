// Unit tests for urgd-pulse-getSessionState — snapshot/totalSections/image branch
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const getSignedUrlMock = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return dynamoSendSpy(...args) }
  }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(...args) { return s3SendSpy(...args) }
  }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args) => getSignedUrlMock(...args),
}))

function makeEvent(sessionId, tenantId) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { sessionId, tenantId },
    },
  }
}

function makeSessionItem(overrides = {}) {
  return {
    tenantId: { S: 'tenant-abc' },
    sessionId: { S: 'session-xyz' },
    itemId: { S: 'item-123' },
    status: { S: 'not_started' },
    currentSection: { N: '1' },
    timeLimitMinutes: { N: '30' },
    closingState: { S: 'exploring' },
    ...overrides,
  }
}

function makeItemRecord(overrides = {}) {
  return {
    tenantId: { S: 'tenant-abc' },
    itemId: { S: 'item-123' },
    itemName: { S: 'Test Item' },
    itemType: { S: 'document' },
    documentKey: { S: 'pulse/tenant-abc/items/item-123/document.pdf' },
    documentStatus: { S: 'ready' },
    ...overrides,
  }
}

const { handler } = await import('../../lambdas/urgd-pulse-getSessionState/index.mjs')

describe('urgd-pulse-getSessionState', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    getSignedUrlMock.mockReset()
    getSignedUrlMock.mockResolvedValue('https://presigned-url.example.com/image.jpg')
  })

  describe('frozenSnapshot with 3 feedbackSections → totalSections: 3', () => {
    it('uses feedbackSections.length from frozenSnapshot as totalSections', async () => {
      const sessionWithSnapshot = makeSessionItem({
        frozenSnapshot: {
          M: {
            feedbackSections: {
              L: [{ S: 's1' }, { S: 's2' }, { S: 's3' }],
            },
            sectionMap: { M: {} },
            sectionDepthPreferences: { M: {} },
          },
        },
      })

      dynamoSendSpy
        .mockResolvedValueOnce({ Item: sessionWithSnapshot }) // GetItem session
        .mockResolvedValueOnce({ Items: [] }) // Query transcripts
        .mockResolvedValueOnce({ Item: makeItemRecord() }) // GetItem item

      const event = makeEvent('session-xyz', 'tenant-abc')
      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.data.totalSections).toBe(3)
    })
  })

  describe('no frozenSnapshot → totalSections: 5 (default)', () => {
    it('uses default totalSections of 5 when no frozenSnapshot and no session.totalSections', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem() }) // GetItem session (no frozenSnapshot, no totalSections)
        .mockResolvedValueOnce({ Items: [] }) // Query transcripts
        .mockResolvedValueOnce({ Item: makeItemRecord() }) // GetItem item

      const event = makeEvent('session-xyz', 'tenant-abc')
      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.data.totalSections).toBe(5)
    })
  })

  describe('no frozenSnapshot, session.totalSections: 7 → totalSections: 7', () => {
    it('uses session.totalSections when no frozenSnapshot', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem({ totalSections: { N: '7' } }) }) // GetItem session
        .mockResolvedValueOnce({ Items: [] }) // Query transcripts
        .mockResolvedValueOnce({ Item: makeItemRecord() }) // GetItem item

      const event = makeEvent('session-xyz', 'tenant-abc')
      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.data.totalSections).toBe(7)
    })
  })

  describe('image item → returns itemType: image and imageUrl (presigned URL)', () => {
    it('returns itemType image and a presigned imageUrl for image items', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem() }) // GetItem session
        .mockResolvedValueOnce({ Items: [] }) // Query transcripts
        .mockResolvedValueOnce({ Item: makeItemRecord({ itemType: { S: 'image' }, documentKey: { S: 'pulse/tenant-abc/items/item-123/photo.jpg' } }) }) // GetItem item

      const event = makeEvent('session-xyz', 'tenant-abc')
      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.data.itemType).toBe('image')
      expect(body.data.imageUrl).toBe('https://presigned-url.example.com/image.jpg')
      expect(getSignedUrlMock).toHaveBeenCalledOnce()
    })
  })

  describe('document item → returns itemType: document, imageUrl: null', () => {
    it('returns itemType document and null imageUrl for document items', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem() }) // GetItem session
        .mockResolvedValueOnce({ Items: [] }) // Query transcripts
        .mockResolvedValueOnce({ Item: makeItemRecord({ itemType: { S: 'document' } }) }) // GetItem item

      const event = makeEvent('session-xyz', 'tenant-abc')
      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.data.itemType).toBe('document')
      expect(body.data.imageUrl).toBeNull()
      expect(getSignedUrlMock).not.toHaveBeenCalled()
    })
  })
})
