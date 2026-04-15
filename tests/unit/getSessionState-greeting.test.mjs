// Unit tests for GetSessionState Lambda — templateGreeting response
// Validates: Requirements 4.1, 4.5, 12.4
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

function makeEvent(sessionId = 'session-xyz', tenantId = 'tenant-abc') {
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

describe('GetSessionState Lambda — templateGreeting response', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    getSignedUrlMock.mockReset()
    getSignedUrlMock.mockResolvedValue('https://presigned-url.example.com/image.jpg')
  })

  describe('templateGreeting returned for not_started sessions (R4.1, R12.4)', () => {
    it('includes templateGreeting in response when session is not_started and item has the field', async () => {
      const greeting = "Hey! I'm Pulse — an AI feedback guide built by ur/gd Studios. I'm here to walk you through Test Item."

      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem({ status: { S: 'not_started' } }) })
        .mockResolvedValueOnce({ Items: [] }) // transcripts
        .mockResolvedValueOnce({ Item: makeItemRecord({ templateGreeting: { S: greeting } }) })

      const result = await handler(makeEvent())
      expect(result.statusCode).toBe(200)

      const body = JSON.parse(result.body)
      expect(body.data.templateGreeting).toBe(greeting)
    })
  })

  describe('templateGreeting absent for in_progress sessions (R4.5)', () => {
    it('does not include templateGreeting when session is in_progress', async () => {
      const greeting = "Hey! I'm Pulse — an AI feedback guide."

      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem({ status: { S: 'in_progress' } }) })
        .mockResolvedValueOnce({ Items: [] }) // transcripts
        .mockResolvedValueOnce({ Item: makeItemRecord({ templateGreeting: { S: greeting } }) })

      const result = await handler(makeEvent())
      expect(result.statusCode).toBe(200)

      const body = JSON.parse(result.body)
      expect(body.data.templateGreeting).toBeUndefined()
    })
  })

  describe('templateGreeting absent for legacy items without the field (R4.5)', () => {
    it('does not include templateGreeting when item record lacks the field', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem({ status: { S: 'not_started' } }) })
        .mockResolvedValueOnce({ Items: [] }) // transcripts
        .mockResolvedValueOnce({ Item: makeItemRecord() }) // no templateGreeting field

      const result = await handler(makeEvent())
      expect(result.statusCode).toBe(200)

      const body = JSON.parse(result.body)
      expect(body.data.templateGreeting).toBeUndefined()
    })
  })

  describe('templateGreeting is item-scoped — same for all session types (R12.4)', () => {
    it('returns the same templateGreeting regardless of session type', async () => {
      const greeting = "Hey! I'm Pulse — an AI feedback guide built by ur/gd Studios. I'm here to walk you through Shared Item."
      const itemRecord = makeItemRecord({ templateGreeting: { S: greeting } })

      // Simulate two different sessions on the same item
      // Session 1: invited reviewer
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem({ sessionId: { S: 'session-invited' }, status: { S: 'not_started' } }) })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({ Item: itemRecord })

      const result1 = await handler(makeEvent('session-invited', 'tenant-abc'))
      const body1 = JSON.parse(result1.body)

      dynamoSendSpy.mockReset()

      // Session 2: self-review
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem({ sessionId: { S: 'session-self' }, isSelfReview: { BOOL: true }, status: { S: 'not_started' } }) })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({ Item: itemRecord })

      const result2 = await handler(makeEvent('session-self', 'tenant-abc'))
      const body2 = JSON.parse(result2.body)

      expect(body1.data.templateGreeting).toBe(greeting)
      expect(body2.data.templateGreeting).toBe(greeting)
      expect(body1.data.templateGreeting).toBe(body2.data.templateGreeting)
    })
  })
})
