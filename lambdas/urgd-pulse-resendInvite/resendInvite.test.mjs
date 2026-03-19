// Unit tests for urgd-pulse-resendInvite
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('APP_URL', 'https://pulse.urgdstudios.com')
vi.stubEnv('ALERTS_TOPIC_ARN', 'arn:aws:sns:us-west-2:123456789012:urgd-pulse-alerts-dev')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const sesSendSpy = vi.fn()
const snsSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3SendSpy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/client-ses', () => {
  class SESClient { send(...args) { return sesSendSpy(...args) } }
  class SendEmailCommand { constructor(input) { this.input = input } }
  class SendRawEmailCommand { constructor(input) { this.input = input } }
  return { SESClient, SendEmailCommand, SendRawEmailCommand }
})

vi.mock('@aws-sdk/client-sns', () => {
  class SNSClient { send(...args) { return snsSendSpy(...args) } }
  class PublishCommand { constructor(input) { this.input = input } }
  return { SNSClient, PublishCommand }
})

const { handler } = await import('./index.mjs')

const SESSION_RECORD = {
  tenantId: { S: 'tenant-abc' },
  sessionId: { S: 'session-xyz' },
  itemId: { S: 'item-123' },
  reviewerEmail: { S: 'reviewer@example.com' },
  pulseCode: { S: 'ABCD1234' },
  status: { S: 'not_started' },
}

const ITEM_RECORD = {
  tenantId: { S: 'tenant-abc' },
  itemId: { S: 'item-123' },
  itemName: { S: 'My Review Item' },
}

function makeEvent(tenantId, itemId, sessionId) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { tenantId },
    },
    pathParameters: { itemId, sessionId },
  }
}

// Helper: create a fake async iterable for S3 body
function makeS3Body(buffer) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield buffer
    },
  }
}

describe('urgd-pulse-resendInvite', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    sesSendSpy.mockReset()
    snsSendSpy.mockReset()
    sesSendSpy.mockResolvedValue({})
    snsSendSpy.mockResolvedValue({})
  })

  describe('successful resend', () => {
    it('resends email for "not_started" session and returns 200', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.sessionId) return Promise.resolve({ Item: SESSION_RECORD })
          return Promise.resolve({ Item: ITEM_RECORD })
        }
        return Promise.resolve({})
      })
      s3SendSpy.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))

      const res = await handler(makeEvent('tenant-abc', 'item-123', 'session-xyz'))

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.sessionId).toBe('session-xyz')
      expect(body.data.status).toBe('not_started')
      expect(sesSendSpy).toHaveBeenCalledOnce()
    })

    it('loads QR code from S3 if available and sends raw email', async () => {
      const fakeQr = Buffer.from('fake-qr-data')

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.sessionId) return Promise.resolve({ Item: SESSION_RECORD })
          return Promise.resolve({ Item: ITEM_RECORD })
        }
        return Promise.resolve({})
      })
      s3SendSpy.mockResolvedValue({ Body: makeS3Body(fakeQr) })

      const res = await handler(makeEvent('tenant-abc', 'item-123', 'session-xyz'))

      expect(res.statusCode).toBe(200)
      // SendRawEmailCommand should be used when QR code is available
      const sesCall = sesSendSpy.mock.calls[0][0]
      expect(sesCall.constructor.name).toBe('SendRawEmailCommand')
    })

    it('gracefully handles missing QR code and sends plain email', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.sessionId) return Promise.resolve({ Item: SESSION_RECORD })
          return Promise.resolve({ Item: ITEM_RECORD })
        }
        return Promise.resolve({})
      })
      s3SendSpy.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))

      const res = await handler(makeEvent('tenant-abc', 'item-123', 'session-xyz'))

      expect(res.statusCode).toBe(200)
      // SendEmailCommand (plain) should be used when QR code is missing
      const sesCall = sesSendSpy.mock.calls[0][0]
      expect(sesCall.constructor.name).toBe('SendEmailCommand')
    })
  })

  describe('session status validation', () => {
    it('returns 409 when session status is "in_progress"', async () => {
      const inProgressSession = { ...SESSION_RECORD, status: { S: 'in_progress' } }
      dynamoSendSpy.mockResolvedValue({ Item: inProgressSession })

      const res = await handler(makeEvent('tenant-abc', 'item-123', 'session-xyz'))

      expect(res.statusCode).toBe(409)
      expect(JSON.parse(res.body).message).toMatch(/already started/i)
    })

    it('returns 409 when session status is "completed"', async () => {
      const completedSession = { ...SESSION_RECORD, status: { S: 'completed' } }
      dynamoSendSpy.mockResolvedValue({ Item: completedSession })

      const res = await handler(makeEvent('tenant-abc', 'item-123', 'session-xyz'))

      expect(res.statusCode).toBe(409)
    })
  })

  describe('session lookup', () => {
    it('returns 404 when session not found', async () => {
      dynamoSendSpy.mockResolvedValue({ Item: undefined })

      const res = await handler(makeEvent('tenant-abc', 'item-123', 'session-xyz'))

      expect(res.statusCode).toBe(404)
    })

    it('returns 404 when session belongs to a different item', async () => {
      const wrongItemSession = { ...SESSION_RECORD, itemId: { S: 'item-different' } }
      dynamoSendSpy.mockResolvedValue({ Item: wrongItemSession })

      const res = await handler(makeEvent('tenant-abc', 'item-123', 'session-xyz'))

      expect(res.statusCode).toBe(404)
    })
  })

  describe('SES failure handling', () => {
    it('publishes SNS alert and returns 502 when SES fails', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.sessionId) return Promise.resolve({ Item: SESSION_RECORD })
          return Promise.resolve({ Item: ITEM_RECORD })
        }
        return Promise.resolve({})
      })
      s3SendSpy.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
      sesSendSpy.mockRejectedValue(new Error('SES unavailable'))

      const res = await handler(makeEvent('tenant-abc', 'item-123', 'session-xyz'))

      expect(res.statusCode).toBe(502)
      expect(snsSendSpy).toHaveBeenCalledOnce()
      const snsCall = snsSendSpy.mock.calls[0][0]
      expect(snsCall.constructor.name).toBe('PublishCommand')
    })
  })
})
