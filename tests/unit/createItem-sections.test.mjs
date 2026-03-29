// Unit tests for urgd-pulse-createItem — sections, image type, analyzeDocument
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('DATA_BUCKET_NAME', 'urgd-pulse-data-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')
vi.stubEnv('ANALYZE_DOCUMENT_FUNCTION_ARN', 'arn:aws:lambda:us-west-2:123456789:function:urgd-pulse-analyzeDocument-dev')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const lambdaSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return dynamoSendSpy(...args) }
  }
  class GetItemCommand { constructor(input) { this.input = input } }
  class PutItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(...args) { return s3SendSpy(...args) }
  }
  class PutObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, PutObjectCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient {
    send(...args) { return lambdaSendSpy(...args) }
  }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

function makeEvent({ tenantId, body } = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: tenantId ? { tenantId } : {},
    },
    body: JSON.stringify(body || {}),
  }
}

function makeTenantRecord() {
  return {
    Item: {
      tenantId: { S: 'tenant-abc' },
      tier: { S: 'pro' },
      features: { M: {} },
      serviceFlags: { M: {} },
    },
  }
}

function makeSystemRecord() {
  return {
    Item: {
      tenantId: { S: 'SYSTEM' },
      serviceFlags: { M: {} },
    },
  }
}

const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

const { handler } = await import('../../lambdas/urgd-pulse-createItem/index.mjs')

describe('urgd-pulse-createItem — sections and image type', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    lambdaSendSpy.mockReset()
    s3SendSpy.mockResolvedValue({})
    lambdaSendSpy.mockResolvedValue({})
  })

  function setupDynamoMocks({ activeCount = 0 } = {}) {
    dynamoSendSpy
      .mockResolvedValueOnce(makeTenantRecord()) // GetItem tenant
      .mockResolvedValueOnce(makeSystemRecord()) // GetItem SYSTEM
      .mockResolvedValueOnce({ Count: activeCount }) // QueryCommand existing items
      .mockResolvedValueOnce({}) // PutItemCommand
  }

  describe('analyzeDocument invoked async when document content provided (non-image)', () => {
    it('invokes analyzeDocument Lambda when content is provided for a document item', async () => {
      setupDynamoMocks()

      const event = makeEvent({
        tenantId: 'tenant-abc',
        body: {
          itemName: 'My Document',
          description: 'Please review this document.',
          closeDate: futureDate,
          content: '# Introduction\n\nThis is the document content.',
        },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(201)
      expect(lambdaSendSpy).toHaveBeenCalledOnce()
      const lambdaCall = lambdaSendSpy.mock.calls[0][0]
      expect(lambdaCall.input.FunctionName).toBe('arn:aws:lambda:us-west-2:123456789:function:urgd-pulse-analyzeDocument-dev')
      expect(lambdaCall.input.InvocationType).toBe('Event')
    })
  })

  describe('feedbackSections stored on item record when provided', () => {
    it('stores feedbackSections in DynamoDB PutItem', async () => {
      setupDynamoMocks()

      const event = makeEvent({
        tenantId: 'tenant-abc',
        body: {
          itemName: 'My Document',
          description: 'Please review this document.',
          closeDate: futureDate,
          feedbackSections: ['s1', 's2', 's3'],
        },
      })

      await handler(event)

      const dynamoCalls = dynamoSendSpy.mock.calls.map(c => c[0])
      const putCall = dynamoCalls.find(c => c.constructor.name === 'PutItemCommand')
      expect(putCall).toBeDefined()
      expect(putCall.input.Item.feedbackSections).toBeDefined()
      expect(putCall.input.Item.feedbackSections.L).toHaveLength(3)
      expect(putCall.input.Item.feedbackSections.L[0].S).toBe('s1')
    })
  })

  describe('sectionDepthPreferences stored on item record when provided', () => {
    it('stores sectionDepthPreferences in DynamoDB PutItem', async () => {
      setupDynamoMocks()

      const event = makeEvent({
        tenantId: 'tenant-abc',
        body: {
          itemName: 'My Document',
          description: 'Please review this document.',
          closeDate: futureDate,
          sectionDepthPreferences: { s1: 'deep', s2: 'explore', s3: 'skim' },
        },
      })

      await handler(event)

      const dynamoCalls = dynamoSendSpy.mock.calls.map(c => c[0])
      const putCall = dynamoCalls.find(c => c.constructor.name === 'PutItemCommand')
      expect(putCall).toBeDefined()
      expect(putCall.input.Item.sectionDepthPreferences).toBeDefined()
      expect(putCall.input.Item.sectionDepthPreferences.M.s1.S).toBe('deep')
      expect(putCall.input.Item.sectionDepthPreferences.M.s2.S).toBe('explore')
    })
  })

  describe('image MIME type → totalSections: 1, recommendedTimeLimitMinutes: 7', () => {
    it('sets totalSections to 1 and recommendedTimeLimitMinutes to 7 for image items', async () => {
      setupDynamoMocks()

      const event = makeEvent({
        tenantId: 'tenant-abc',
        body: {
          itemName: 'My Photo',
          description: 'Please review this image.',
          closeDate: futureDate,
          itemType: 'image/jpeg',
        },
      })

      await handler(event)

      const dynamoCalls = dynamoSendSpy.mock.calls.map(c => c[0])
      const putCall = dynamoCalls.find(c => c.constructor.name === 'PutItemCommand')
      expect(putCall).toBeDefined()
      expect(putCall.input.Item.totalSections.N).toBe('1')
      expect(putCall.input.Item.recommendedTimeLimitMinutes.N).toBe('7')
    })
  })

  describe('image MIME type → itemType: image', () => {
    it.each(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])('sets itemType to image for %s', async (mimeType) => {
      setupDynamoMocks()

      const event = makeEvent({
        tenantId: 'tenant-abc',
        body: {
          itemName: 'My Photo',
          description: 'Please review this image.',
          closeDate: futureDate,
          itemType: mimeType,
        },
      })

      await handler(event)

      const dynamoCalls = dynamoSendSpy.mock.calls.map(c => c[0])
      const putCall = dynamoCalls.find(c => c.constructor.name === 'PutItemCommand')
      expect(putCall.input.Item.itemType.S).toBe('image')
    })
  })

  describe('document MIME type → itemType: document', () => {
    it('sets itemType to document when no itemType provided', async () => {
      setupDynamoMocks()

      const event = makeEvent({
        tenantId: 'tenant-abc',
        body: {
          itemName: 'My Document',
          description: 'Please review this document.',
          closeDate: futureDate,
        },
      })

      await handler(event)

      const dynamoCalls = dynamoSendSpy.mock.calls.map(c => c[0])
      const putCall = dynamoCalls.find(c => c.constructor.name === 'PutItemCommand')
      expect(putCall.input.Item.itemType.S).toBe('document')
    })
  })

  describe('analyzeDocument NOT invoked for image items', () => {
    it('does not invoke analyzeDocument Lambda for image items', async () => {
      setupDynamoMocks()

      const event = makeEvent({
        tenantId: 'tenant-abc',
        body: {
          itemName: 'My Photo',
          description: 'Please review this image.',
          closeDate: futureDate,
          itemType: 'image/jpeg',
          content: 'some content',
        },
      })

      await handler(event)

      // Lambda should NOT be called for image items
      expect(lambdaSendSpy).not.toHaveBeenCalled()
    })
  })
})
