// Unit tests for urgd-pulse-sendReminder
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('ALERTS_TOPIC_ARN', 'arn:aws:sns:us-west-2:123456789012:urgd-pulse-alerts-dev')
vi.stubEnv('APP_URL', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const sesSendSpy = vi.fn()
const snsSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class ScanCommand { constructor(input) { this.input = input } }
  class GetItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, ScanCommand, GetItemCommand }
})

vi.mock('@aws-sdk/client-ses', () => {
  class SESClient { send(...args) { return sesSendSpy(...args) } }
  class SendEmailCommand { constructor(input) { this.input = input } }
  return { SESClient, SendEmailCommand }
})

vi.mock('@aws-sdk/client-sns', () => {
  class SNSClient { send(...args) { return snsSendSpy(...args) } }
  class PublishCommand { constructor(input) { this.input = input } }
  return { SNSClient, PublishCommand }
})

const { handler } = await import('./index.mjs')

// Dates for test fixtures
const NOW = new Date()
const WITHIN_48H = new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString()  // 24h from now
const BEYOND_48H = new Date(NOW.getTime() + 72 * 60 * 60 * 1000).toISOString()  // 72h from now
const PAST_DATE = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()         // 1h ago

function makeSession(overrides = {}) {
  return {
    tenantId: { S: 'tenant-abc' },
    sessionId: { S: 'session-123' },
    itemId: { S: 'item-456' },
    reviewerEmail: { S: 'reviewer@example.com' },
    pulseCode: { S: 'ABCD1234' },
    status: { S: 'not_started' },
    expiresAt: { S: WITHIN_48H },
    ...overrides,
  }
}

function makeItem(closeDate = WITHIN_48H) {
  return {
    tenantId: { S: 'tenant-abc' },
    itemId: { S: 'item-456' },
    itemName: { S: 'Test Item' },
    closeDate: { S: closeDate },
  }
}

function makeTenant(emailReminders = true) {
  return {
    tenantId: { S: 'tenant-abc' },
    features: { M: { emailReminders: { BOOL: emailReminders } } },
  }
}

describe('urgd-pulse-sendReminder', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    sesSendSpy.mockReset()
    snsSendSpy.mockReset()
    sesSendSpy.mockResolvedValue({})
    snsSendSpy.mockResolvedValue({})
  })

  describe('sends emails for approaching deadlines', () => {
    it('sends reminder email for not_started session with closeDate within 48h', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') {
          return Promise.resolve({ Items: [makeSession()], Count: 1 })
        }
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: makeItem() })
          return Promise.resolve({ Item: makeTenant() })
        }
        return Promise.resolve({})
      })

      const result = await handler({})

      expect(sesSendSpy).toHaveBeenCalledTimes(1)
      expect(result.totalSent).toBe(1)
      expect(result.totalSkipped).toBe(0)
    })

    it('sends reminder email for in_progress session with closeDate within 48h', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') {
          return Promise.resolve({ Items: [makeSession({ status: { S: 'in_progress' } })], Count: 1 })
        }
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: makeItem() })
          return Promise.resolve({ Item: makeTenant() })
        }
        return Promise.resolve({})
      })

      const result = await handler({})

      expect(sesSendSpy).toHaveBeenCalledTimes(1)
      expect(result.totalSent).toBe(1)
    })

    it('sends multiple reminders for multiple eligible sessions', async () => {
      const sessions = [
        makeSession({ sessionId: { S: 'session-1' }, reviewerEmail: { S: 'a@test.com' } }),
        makeSession({ sessionId: { S: 'session-2' }, reviewerEmail: { S: 'b@test.com' } }),
        makeSession({ sessionId: { S: 'session-3' }, reviewerEmail: { S: 'c@test.com' } }),
      ]

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: sessions, Count: sessions.length })
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: makeItem() })
          return Promise.resolve({ Item: makeTenant() })
        }
        return Promise.resolve({})
      })

      const result = await handler({})

      expect(sesSendSpy).toHaveBeenCalledTimes(3)
      expect(result.totalSent).toBe(3)
    })
  })

  describe('skips tenants with emailReminders: false', () => {
    it('does not send email when emailReminders feature flag is false', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [makeSession()], Count: 1 })
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: makeItem() })
          return Promise.resolve({ Item: makeTenant(false) }) // emailReminders: false
        }
        return Promise.resolve({})
      })

      const result = await handler({})

      expect(sesSendSpy).not.toHaveBeenCalled()
      expect(result.totalSkipped).toBe(1)
      expect(result.totalSent).toBe(0)
    })
  })

  describe('skips completed and expired sessions', () => {
    it('does not send email for completed sessions (scan filter excludes them)', async () => {
      // Scan returns empty — completed sessions are filtered out by DynamoDB scan expression
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [], Count: 0 })
        return Promise.resolve({})
      })

      const result = await handler({})

      expect(sesSendSpy).not.toHaveBeenCalled()
      expect(result.totalSent).toBe(0)
    })

    it('skips sessions with closeDate beyond 48h window', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') {
          return Promise.resolve({ Items: [makeSession({ expiresAt: { S: BEYOND_48H } })], Count: 1 })
        }
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: makeItem(BEYOND_48H) })
          return Promise.resolve({ Item: makeTenant() })
        }
        return Promise.resolve({})
      })

      const result = await handler({})

      expect(sesSendSpy).not.toHaveBeenCalled()
      expect(result.totalSkipped).toBe(1)
    })

    it('skips sessions with past closeDate', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') {
          return Promise.resolve({ Items: [makeSession({ expiresAt: { S: PAST_DATE } })], Count: 1 })
        }
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: makeItem(PAST_DATE) })
          return Promise.resolve({ Item: makeTenant() })
        }
        return Promise.resolve({})
      })

      const result = await handler({})

      expect(sesSendSpy).not.toHaveBeenCalled()
      expect(result.totalSkipped).toBe(1)
    })
  })

  describe('SES failure handling', () => {
    it('publishes SNS alert and counts as skipped when SES fails', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [makeSession()], Count: 1 })
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: makeItem() })
          return Promise.resolve({ Item: makeTenant() })
        }
        return Promise.resolve({})
      })

      sesSendSpy.mockRejectedValue(new Error('SES unavailable'))

      const result = await handler({})

      expect(snsSendSpy).toHaveBeenCalledTimes(1)
      expect(result.totalSent).toBe(0)
      expect(result.totalSkipped).toBe(1)
    })
  })

  describe('no PII in logs', () => {
    it('does not log reviewer email', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [makeSession()], Count: 1 })
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: makeItem() })
          return Promise.resolve({ Item: makeTenant() })
        }
        return Promise.resolve({})
      })

      await handler({})

      const allLogs = [...logSpy.mock.calls, ...errorSpy.mock.calls]
        .map(args => args.join(' '))
        .join('\n')

      expect(allLogs).not.toContain('reviewer@example.com')

      logSpy.mockRestore()
      errorSpy.mockRestore()
    })
  })

  describe('empty scan result', () => {
    it('returns zero counts when no sessions are eligible', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [], Count: 0 })
        return Promise.resolve({})
      })

      const result = await handler({})

      expect(result.totalScanned).toBe(0)
      expect(result.totalSent).toBe(0)
      expect(result.totalSkipped).toBe(0)
      expect(sesSendSpy).not.toHaveBeenCalled()
    })
  })

  describe('malformed session records', () => {
    it('skips session with missing tenantId', async () => {
      const bad = makeSession()
      delete bad.tenantId
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [bad], Count: 1 })
        return Promise.resolve({})
      })
      const result = await handler({})
      expect(result.totalSkipped).toBe(1)
      expect(sesSendSpy).not.toHaveBeenCalled()
    })

    it('skips session with missing reviewerEmail', async () => {
      const bad = makeSession()
      delete bad.reviewerEmail
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [bad], Count: 1 })
        return Promise.resolve({})
      })
      const result = await handler({})
      expect(result.totalSkipped).toBe(1)
      expect(sesSendSpy).not.toHaveBeenCalled()
    })

    it('skips session when item is not found', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [makeSession()], Count: 1 })
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: null }) // item not found
          return Promise.resolve({ Item: makeTenant() })
        }
        return Promise.resolve({})
      })
      const result = await handler({})
      expect(result.totalSkipped).toBe(1)
      expect(sesSendSpy).not.toHaveBeenCalled()
    })

    it('skips session when item has no closeDate', async () => {
      const itemNoClose = { tenantId: { S: 'tenant-abc' }, itemId: { S: 'item-456' }, itemName: { S: 'Test' } }
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [makeSession()], Count: 1 })
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: itemNoClose })
          return Promise.resolve({ Item: makeTenant() })
        }
        return Promise.resolve({})
      })
      const result = await handler({})
      expect(result.totalSkipped).toBe(1)
      expect(sesSendSpy).not.toHaveBeenCalled()
    })

    it('skips session with already-expired expiresAt', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') {
          return Promise.resolve({ Items: [makeSession({ expiresAt: { S: PAST_DATE } })], Count: 1 })
        }
        return Promise.resolve({})
      })
      const result = await handler({})
      expect(result.totalSkipped).toBe(1)
      expect(sesSendSpy).not.toHaveBeenCalled()
    })
  })

  describe('tenant flag fetch failure', () => {
    it('defaults to sending reminder when tenant GetItem throws', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [makeSession()], Count: 1 })
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: makeItem() })
          return Promise.reject(new Error('DynamoDB error')) // tenant fetch fails
        }
        return Promise.resolve({})
      })
      const result = await handler({})
      // Defaults to true — should still send
      expect(sesSendSpy).toHaveBeenCalledTimes(1)
      expect(result.totalSent).toBe(1)
    })

    it('defaults to sending when tenant record is not found', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [makeSession()], Count: 1 })
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: makeItem() })
          return Promise.resolve({ Item: null }) // tenant not found
        }
        return Promise.resolve({})
      })
      const result = await handler({})
      expect(sesSendSpy).toHaveBeenCalledTimes(1)
      expect(result.totalSent).toBe(1)
    })
  })

  describe('SNS alert failure', () => {
    it('continues gracefully when SNS publish fails after SES failure', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [makeSession()], Count: 1 })
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: makeItem() })
          return Promise.resolve({ Item: makeTenant() })
        }
        return Promise.resolve({})
      })
      sesSendSpy.mockRejectedValue(new Error('SES down'))
      snsSendSpy.mockRejectedValue(new Error('SNS down'))

      const result = await handler({})
      expect(result.totalSkipped).toBe(1)
      expect(result.totalSent).toBe(0)
    })
  })
})
