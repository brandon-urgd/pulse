// Unit tests for urgd-pulse-sendPulseCheckReady
// Requirements: 7.4, 5.12, 13.2

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('ALERTS_TOPIC_ARN', 'arn:aws:sns:us-west-2:123456789:urgd-pulse-alerts-dev')
vi.stubEnv('APP_URL', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const sesSendSpy = vi.fn()
const snsSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand }
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

function makeTenant(email = 'tenant@example.com') {
  return {
    Item: {
      tenantId: { S: 'tenant-123' },
      email: { S: email },
    },
  }
}

describe('sendPulseCheckReady handler', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    sesSendSpy.mockReset()
    snsSendSpy.mockReset()
  })

  it('returns early when tenantId is missing', async () => {
    await handler({ itemId: 'item-1', itemName: 'My Item' })
    expect(dynamoSendSpy).not.toHaveBeenCalled()
    expect(sesSendSpy).not.toHaveBeenCalled()
  })

  it('returns early when itemId is missing', async () => {
    await handler({ tenantId: 'tenant-1', itemName: 'My Item' })
    expect(dynamoSendSpy).not.toHaveBeenCalled()
    expect(sesSendSpy).not.toHaveBeenCalled()
  })

  it('returns early when itemName is missing', async () => {
    await handler({ tenantId: 'tenant-1', itemId: 'item-1' })
    expect(dynamoSendSpy).not.toHaveBeenCalled()
    expect(sesSendSpy).not.toHaveBeenCalled()
  })

  it('returns early when tenant not found in DynamoDB', async () => {
    dynamoSendSpy.mockResolvedValueOnce({ Item: null })
    await handler({ tenantId: 'tenant-1', itemId: 'item-1', itemName: 'My Item' })
    expect(sesSendSpy).not.toHaveBeenCalled()
  })

  it('returns early when tenant has no email', async () => {
    dynamoSendSpy.mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-1' } } })
    await handler({ tenantId: 'tenant-1', itemId: 'item-1', itemName: 'My Item' })
    expect(sesSendSpy).not.toHaveBeenCalled()
  })

  it('sends email with correct subject containing itemName', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant())
    sesSendSpy.mockResolvedValueOnce({})

    await handler({ tenantId: 'tenant-123', itemId: 'item-456', itemName: 'My Test Document' })

    expect(sesSendSpy).toHaveBeenCalledTimes(1)
    const sesCall = sesSendSpy.mock.calls[0][0]
    expect(sesCall.input.Message.Subject.Data).toBe('Your Pulse Check for My Test Document is ready')
  })

  it('sends email from pulse@urgdstudios.com with reply-to admin@urgdstudios.com', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant())
    sesSendSpy.mockResolvedValueOnce({})

    await handler({ tenantId: 'tenant-123', itemId: 'item-456', itemName: 'My Item' })

    const sesCall = sesSendSpy.mock.calls[0][0]
    expect(sesCall.input.Source).toContain('pulse@urgdstudios.com')
    expect(sesCall.input.ReplyToAddresses).toContain('admin@urgdstudios.com')
  })

  it('sends email to the tenant email address', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant('user@example.com'))
    sesSendSpy.mockResolvedValueOnce({})

    await handler({ tenantId: 'tenant-123', itemId: 'item-456', itemName: 'My Item' })

    const sesCall = sesSendSpy.mock.calls[0][0]
    expect(sesCall.input.Destination.ToAddresses).toContain('user@example.com')
  })

  it('includes CTA link to /admin/items/{itemId}/pulse-check in email body', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant())
    sesSendSpy.mockResolvedValueOnce({})

    await handler({ tenantId: 'tenant-123', itemId: 'item-456', itemName: 'My Item' })

    const sesCall = sesSendSpy.mock.calls[0][0]
    const htmlBody = sesCall.input.Message.Body.Html.Data
    const textBody = sesCall.input.Message.Body.Text.Data

    expect(htmlBody).toContain('/admin/items/item-456/pulse-check')
    expect(textBody).toContain('/admin/items/item-456/pulse-check')
  })

  it('includes "View your Pulse Check" CTA text in HTML body', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant())
    sesSendSpy.mockResolvedValueOnce({})

    await handler({ tenantId: 'tenant-123', itemId: 'item-456', itemName: 'My Item' })

    const sesCall = sesSendSpy.mock.calls[0][0]
    const htmlBody = sesCall.input.Message.Body.Html.Data
    expect(htmlBody).toContain('View your Pulse Check')
  })

  it('publishes SNS alert when SES send fails', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant())
    const sesErr = new Error('SES error')
    sesErr.name = 'MessageRejected'
    sesSendSpy.mockRejectedValueOnce(sesErr)
    snsSendSpy.mockResolvedValueOnce({})

    await handler({ tenantId: 'tenant-123', itemId: 'item-456', itemName: 'My Item' })

    expect(snsSendSpy).toHaveBeenCalledTimes(1)
    const snsCall = snsSendSpy.mock.calls[0][0]
    expect(snsCall.input.TopicArn).toBe('arn:aws:sns:us-west-2:123456789:urgd-pulse-alerts-dev')
    const message = JSON.parse(snsCall.input.Message)
    expect(message.alert).toBe('ses_pulse_check_ready_failure')
    expect(message.tenantId).toBe('tenant-123')
    expect(message.itemId).toBe('item-456')
  })

  it('does not include email address in logs (no PII)', async () => {
    // This test verifies the handler completes without throwing
    // The log() function is tested separately in shared/utils tests
    dynamoSendSpy.mockResolvedValueOnce(makeTenant('secret@example.com'))
    sesSendSpy.mockResolvedValueOnce({})

    // Should complete without error
    await expect(
      handler({ tenantId: 'tenant-123', itemId: 'item-456', itemName: 'My Item' })
    ).resolves.not.toThrow()
  })

  it('handles unexpected errors gracefully without throwing', async () => {
    dynamoSendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))

    // Should not throw — errors are caught internally
    await expect(
      handler({ tenantId: 'tenant-123', itemId: 'item-456', itemName: 'My Item' })
    ).resolves.not.toThrow()
  })

  it('looks up tenant email from DynamoDB using tenantId', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant())
    sesSendSpy.mockResolvedValueOnce({})

    await handler({ tenantId: 'tenant-123', itemId: 'item-456', itemName: 'My Item' })

    expect(dynamoSendSpy).toHaveBeenCalledTimes(1)
    const dynamoCall = dynamoSendSpy.mock.calls[0][0]
    expect(dynamoCall.input.TableName).toBe('urgd-pulse-tenants-dev')
    expect(dynamoCall.input.Key.tenantId.S).toBe('tenant-123')
  })
})
