// Unit tests for urgd-pulse-createItem
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('DATA_BUCKET_NAME', 'urgd-pulse-data-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()
const s3SendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return sendSpy(...args) }
  }
  class GetItemCommand { constructor(input) { this.input = input } }
  class PutItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(...args) { return s3SendSpy(...args) }
  }
  class PutObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, PutObjectCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send() { return Promise.resolve({}) } }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

vi.mock('@aws-sdk/client-scheduler', () => {
  class SchedulerClient { send() { return Promise.resolve({}) } }
  class CreateScheduleCommand { constructor(input) { this.input = input } }
  return { SchedulerClient, CreateScheduleCommand }
})

vi.mock('./shared/counters.mjs', () => ({
  checkAndIncrement: vi.fn(() => Promise.resolve({ allowed: true, newCount: 1 })),
}))

const { handler } = await import('./index.mjs')

const FREE_TENANT = {
  tenantId: { S: 'tenant-free' },
  tier: { S: 'free' },
  features: { M: { maxActiveItems: { N: '1' } } },
}

const PAID_TENANT = {
  tenantId: { S: 'tenant-paid' },
  tier: { S: 'paid' },
  features: { M: { maxActiveItems: { N: '25' } } },
}

function makeFutureDate() {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
}

function makeEvent(tenantId, body) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-123',
      authorizer: { tenantId },
    },
    body: JSON.stringify(body),
  }
}

describe('urgd-pulse-createItem', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    s3SendSpy.mockReset()
    s3SendSpy.mockResolvedValue({})
  })

  describe('valid input creates item', () => {
    it('returns 201 with created item for valid input', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: PAID_TENANT })
        .mockResolvedValueOnce({ Count: 0, Items: [] })
        .mockResolvedValueOnce({})

      const res = await handler(makeEvent('tenant-paid', {
        itemName: 'My Item',
        description: 'A test description',
        closeDate: makeFutureDate(),
      }))

      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.data.itemId).toBeDefined()
      expect(body.data.itemName).toBe('My Item')
      expect(body.data.description).toBe('A test description')
      expect(body.data.status).toBe('draft')
      expect(body.data.documentStatus).toBeNull()
      expect(body.data.tenantId).toBe('tenant-paid')
    })

    it('trims whitespace from itemName and description', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: PAID_TENANT })
        .mockResolvedValueOnce({ Count: 0, Items: [] })
        .mockResolvedValueOnce({})

      const res = await handler(makeEvent('tenant-paid', {
        itemName: '  My Item  ',
        description: '  A description  ',
        closeDate: makeFutureDate(),
      }))

      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.data.itemName).toBe('My Item')
      expect(body.data.description).toBe('A description')
    })

    it('stores content in S3 and sets documentStatus to "ready" when content provided', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: PAID_TENANT })
        .mockResolvedValueOnce({ Count: 0, Items: [] })
        .mockResolvedValueOnce({})

      const res = await handler(makeEvent('tenant-paid', {
        itemName: 'My Item',
        description: 'A description',
        closeDate: makeFutureDate(),
        content: '# My Document\n\nSome content here.',
      }))

      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.data.documentStatus).toBe('ready')

      // Verify S3 PutObject was called
      expect(s3SendSpy).toHaveBeenCalledOnce()
      const s3Call = s3SendSpy.mock.calls[0][0]
      expect(s3Call.input.Key).toMatch(/^pulse\/tenant-paid\/items\/.+\/document\.md$/)
      expect(s3Call.input.Body).toBe('# My Document\n\nSome content here.')
    })

    it('does not call S3 when no content provided', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: PAID_TENANT })
        .mockResolvedValueOnce({ Count: 0, Items: [] })
        .mockResolvedValueOnce({})

      await handler(makeEvent('tenant-paid', {
        itemName: 'My Item',
        description: 'A description',
        closeDate: makeFutureDate(),
      }))

      expect(s3SendSpy).not.toHaveBeenCalled()
    })
  })

  describe('maxActiveItems limit returns 403', () => {
    it('returns 403 when free tenant is at limit (1 item)', async () => {
      sendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key?.tenantId?.S
          if (key === 'SYSTEM') return Promise.resolve({ Item: { tenantId: { S: 'SYSTEM' }, serviceFlags: { M: {} } } })
          return Promise.resolve({ Item: FREE_TENANT })
        }
        if (name === 'QueryCommand') return Promise.resolve({ Count: 1, Items: [] })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent('tenant-free', {
        itemName: 'My Item',
        description: 'A description',
        closeDate: makeFutureDate(),
      }))

      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).message).toMatch(/item limit/i)
    })

    it('returns 403 when paid tenant is at limit (25 items)', async () => {
      sendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key?.tenantId?.S
          if (key === 'SYSTEM') return Promise.resolve({ Item: { tenantId: { S: 'SYSTEM' }, serviceFlags: { M: {} } } })
          return Promise.resolve({ Item: PAID_TENANT })
        }
        if (name === 'QueryCommand') return Promise.resolve({ Count: 25, Items: [] })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent('tenant-paid', {
        itemName: 'My Item',
        description: 'A description',
        closeDate: makeFutureDate(),
      }))

      expect(res.statusCode).toBe(403)
    })

    it('allows creation when free tenant has 0 items', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: FREE_TENANT })
        .mockResolvedValueOnce({ Count: 0, Items: [] })
        .mockResolvedValueOnce({})

      const res = await handler(makeEvent('tenant-free', {
        itemName: 'My Item',
        description: 'A description',
        closeDate: makeFutureDate(),
      }))

      expect(res.statusCode).toBe(201)
    })
  })

  describe('invalid input returns 400', () => {
    it('returns 400 when itemName is missing', async () => {
      const res = await handler(makeEvent('tenant-paid', {
        description: 'A description',
        closeDate: makeFutureDate(),
      }))
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).message).toMatch(/itemName/i)
    })

    it('returns 400 when itemName is empty string', async () => {
      const res = await handler(makeEvent('tenant-paid', {
        itemName: '',
        description: 'A description',
        closeDate: makeFutureDate(),
      }))
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 when itemName exceeds 200 chars', async () => {
      const res = await handler(makeEvent('tenant-paid', {
        itemName: 'a'.repeat(201),
        description: 'A description',
        closeDate: makeFutureDate(),
      }))
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 when description is missing', async () => {
      const res = await handler(makeEvent('tenant-paid', {
        itemName: 'My Item',
        closeDate: makeFutureDate(),
      }))
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).message).toMatch(/description/i)
    })

    it('returns 400 when description exceeds 2000 chars', async () => {
      const res = await handler(makeEvent('tenant-paid', {
        itemName: 'My Item',
        description: 'a'.repeat(2001),
        closeDate: makeFutureDate(),
      }))
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 when closeDate is missing', async () => {
      const res = await handler(makeEvent('tenant-paid', {
        itemName: 'My Item',
        description: 'A description',
      }))
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).message).toMatch(/closeDate/i)
    })

    it('returns 400 when closeDate is in the past', async () => {
      const res = await handler(makeEvent('tenant-paid', {
        itemName: 'My Item',
        description: 'A description',
        closeDate: new Date(Date.now() - 1000).toISOString(),
      }))
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 when closeDate is invalid', async () => {
      const res = await handler(makeEvent('tenant-paid', {
        itemName: 'My Item',
        description: 'A description',
        closeDate: 'not-a-date',
      }))
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 for invalid JSON body', async () => {
      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-123', authorizer: { tenantId: 'tenant-paid' } },
        body: 'not-json',
      })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('auth and error handling', () => {
    it('returns 401 when tenantId is missing from authorizer context', async () => {
      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-123', authorizer: {} },
        body: JSON.stringify({ itemName: 'x', description: 'y', closeDate: makeFutureDate() }),
      })
      expect(res.statusCode).toBe(401)
    })

    it('returns 404 when tenant not found', async () => {
      sendSpy.mockResolvedValueOnce({ Item: undefined })

      const res = await handler(makeEvent('tenant-unknown', {
        itemName: 'My Item',
        description: 'A description',
        closeDate: makeFutureDate(),
      }))
      expect(res.statusCode).toBe(404)
    })

    it('returns 500 on DynamoDB failure', async () => {
      sendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))

      const res = await handler(makeEvent('tenant-paid', {
        itemName: 'My Item',
        description: 'A description',
        closeDate: makeFutureDate(),
      }))
      expect(res.statusCode).toBe(500)
    })

    it('tenantId comes from authorizer context, not request body', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: PAID_TENANT })
        .mockResolvedValueOnce({ Count: 0, Items: [] })
        .mockResolvedValueOnce({})

      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-123', authorizer: { tenantId: 'tenant-paid' } },
        body: JSON.stringify({
          itemName: 'My Item',
          description: 'A description',
          closeDate: makeFutureDate(),
          tenantId: 'injected-tenant-id', // should be ignored
        }),
      })

      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.data.tenantId).toBe('tenant-paid')
      expect(body.data.tenantId).not.toBe('injected-tenant-id')
    })
  })
})
