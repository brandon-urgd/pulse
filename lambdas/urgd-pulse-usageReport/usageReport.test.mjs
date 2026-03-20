// Unit tests for urgd-pulse-usageReport
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('ALERTS_TOPIC_ARN', 'arn:aws:sns:us-west-2:123456789012:pulse-alerts-dev')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()
const cwSendSpy = vi.fn()
const snsSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class ScanCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, ScanCommand }
})

vi.mock('@aws-sdk/client-cloudwatch', () => {
  class CloudWatchClient { send(...args) { return cwSendSpy(...args) } }
  class PutMetricDataCommand { constructor(input) { this.input = input } }
  return { CloudWatchClient, PutMetricDataCommand }
})

vi.mock('@aws-sdk/client-sns', () => {
  class SNSClient { send(...args) { return snsSendSpy(...args) } }
  class PublishCommand { constructor(input) { this.input = input } }
  return { SNSClient, PublishCommand }
})

const { handler } = await import('./index.mjs')

const TENANT_ITEMS = [
  { tenantId: { S: 'tenant-1' }, tier: { S: 'free' } },
  { tenantId: { S: 'tenant-2' }, tier: { S: 'paid' } },
  { tenantId: { S: 'tenant-3' }, tier: { S: 'free' } },
]

const SESSION_ITEMS = [
  { status: { S: 'completed' } },
  { status: { S: 'completed' } },
  { status: { S: 'in_progress' } },
  { status: { S: 'not_started' } },
  { status: { S: 'expired' } },
]

describe('urgd-pulse-usageReport', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    cwSendSpy.mockReset()
    snsSendSpy.mockReset()
    cwSendSpy.mockResolvedValue({})
    snsSendSpy.mockResolvedValue({})
  })

  describe('successful execution', () => {
    it('scans tenants and sessions tables', async () => {
      sendSpy
        .mockResolvedValueOnce({ Items: TENANT_ITEMS }) // Scan tenants
        .mockResolvedValueOnce({ Items: SESSION_ITEMS }) // Scan sessions

      await handler()

      const scanCalls = sendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'ScanCommand')
      expect(scanCalls).toHaveLength(2)

      const tableNames = scanCalls.map(c => c[0].input.TableName)
      expect(tableNames).toContain('urgd-pulse-tenants-dev')
      expect(tableNames).toContain('urgd-pulse-sessions-dev')
    })

    it('publishes ActiveTenants metric', async () => {
      sendSpy
        .mockResolvedValueOnce({ Items: TENANT_ITEMS })
        .mockResolvedValueOnce({ Items: SESSION_ITEMS })

      await handler()

      expect(cwSendSpy).toHaveBeenCalled()
      const cwCall = cwSendSpy.mock.calls[0][0]
      const activeTenantMetric = cwCall.input.MetricData.find(m => m.MetricName === 'ActiveTenants')
      expect(activeTenantMetric).toBeDefined()
      expect(activeTenantMetric.Value).toBe(3)
    })

    it('publishes TotalSessions metric', async () => {
      sendSpy
        .mockResolvedValueOnce({ Items: TENANT_ITEMS })
        .mockResolvedValueOnce({ Items: SESSION_ITEMS })

      await handler()

      const cwCall = cwSendSpy.mock.calls[0][0]
      const totalSessionsMetric = cwCall.input.MetricData.find(m => m.MetricName === 'TotalSessions')
      expect(totalSessionsMetric).toBeDefined()
      expect(totalSessionsMetric.Value).toBe(5)
    })

    it('publishes SessionsByStatus metrics for each status', async () => {
      sendSpy
        .mockResolvedValueOnce({ Items: TENANT_ITEMS })
        .mockResolvedValueOnce({ Items: SESSION_ITEMS })

      await handler()

      const cwCall = cwSendSpy.mock.calls[0][0]
      const statusMetrics = cwCall.input.MetricData.filter(m => m.MetricName === 'SessionsByStatus')

      const completedMetric = statusMetrics.find(m => m.Dimensions?.[0]?.Value === 'completed')
      expect(completedMetric).toBeDefined()
      expect(completedMetric.Value).toBe(2)

      const inProgressMetric = statusMetrics.find(m => m.Dimensions?.[0]?.Value === 'in_progress')
      expect(inProgressMetric).toBeDefined()
      expect(inProgressMetric.Value).toBe(1)
    })

    it('handles paginated DynamoDB scan (LastEvaluatedKey)', async () => {
      sendSpy
        .mockResolvedValueOnce({ Items: [TENANT_ITEMS[0]], LastEvaluatedKey: { tenantId: { S: 'tenant-1' } } })
        .mockResolvedValueOnce({ Items: [TENANT_ITEMS[1], TENANT_ITEMS[2]] }) // Second page
        .mockResolvedValueOnce({ Items: SESSION_ITEMS })

      await handler()

      const cwCall = cwSendSpy.mock.calls[0][0]
      const activeTenantMetric = cwCall.input.MetricData.find(m => m.MetricName === 'ActiveTenants')
      expect(activeTenantMetric.Value).toBe(3) // All 3 tenants from both pages
    })
  })

  describe('failure handling', () => {
    it('publishes SNS alert on failure', async () => {
      sendSpy.mockRejectedValueOnce(new Error('DynamoDB scan failed'))

      await expect(handler()).rejects.toThrow()
      expect(snsSendSpy).toHaveBeenCalled()
    })

    it('rethrows error after publishing alert', async () => {
      sendSpy.mockRejectedValueOnce(new Error('DynamoDB scan failed'))

      await expect(handler()).rejects.toThrow('DynamoDB scan failed')
    })
  })
})
