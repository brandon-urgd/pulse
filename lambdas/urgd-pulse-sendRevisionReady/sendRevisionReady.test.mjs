// Unit tests for urgd-pulse-sendRevisionReady
// Requirements: 3.5, 3.7

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

const validEvent = {
  tenantId: 'tenant-123',
  itemId: 'item-456',
  itemName: 'My Test Document',
  revisionId: 'rev-789',
}

describe('sendRevisionReady handler', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    sesSendSpy.mockReset()
    snsSendSpy.mockReset()
  })

  // --- Successful email send logs success (Req 3.5) ---

  it('sends email successfully and does not throw', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant())
    sesSendSpy.mockResolvedValueOnce({})

    await expect(handler(validEvent)).resolves.not.toThrow()
    expect(sesSendSpy).toHaveBeenCalledTimes(1)
  })

  it('sends email with correct subject containing itemName', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant())
    sesSendSpy.mockResolvedValueOnce({})

    await handler(validEvent)

    const sesCall = sesSendSpy.mock.calls[0][0]
    expect(sesCall.input.Message.Subject.Data).toBe('Your revision for My Test Document is ready')
  })

  it('sends email from pulse@urgdstudios.com with reply-to admin@urgdstudios.com', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant())
    sesSendSpy.mockResolvedValueOnce({})

    await handler(validEvent)

    const sesCall = sesSendSpy.mock.calls[0][0]
    expect(sesCall.input.Source).toContain('pulse@urgdstudios.com')
    expect(sesCall.input.ReplyToAddresses).toContain('admin@urgdstudios.com')
  })

  it('sends email to the tenant email address', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant('user@example.com'))
    sesSendSpy.mockResolvedValueOnce({})

    await handler(validEvent)

    const sesCall = sesSendSpy.mock.calls[0][0]
    expect(sesCall.input.Destination.ToAddresses).toContain('user@example.com')
  })

  it('includes revisions link in both HTML and plain-text bodies', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant())
    sesSendSpy.mockResolvedValueOnce({})

    await handler(validEvent)

    const sesCall = sesSendSpy.mock.calls[0][0]
    const htmlBody = sesCall.input.Message.Body.Html.Data
    const textBody = sesCall.input.Message.Body.Text.Data

    expect(htmlBody).toContain('/admin/items/item-456/revisions')
    expect(textBody).toContain('/admin/items/item-456/revisions')
  })

  it('does not publish SNS alert on successful email send', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant())
    sesSendSpy.mockResolvedValueOnce({})

    await handler(validEvent)

    expect(snsSendSpy).not.toHaveBeenCalled()
  })

  // --- SES failure triggers SNS alert and does not throw (Req 3.5) ---

  it('publishes SNS alert when SES send fails', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant())
    const sesErr = new Error('SES error')
    sesErr.name = 'MessageRejected'
    sesSendSpy.mockRejectedValueOnce(sesErr)
    snsSendSpy.mockResolvedValueOnce({})

    await expect(handler(validEvent)).resolves.not.toThrow()

    expect(snsSendSpy).toHaveBeenCalledTimes(1)
    const snsCall = snsSendSpy.mock.calls[0][0]
    expect(snsCall.input.TopicArn).toBe('arn:aws:sns:us-west-2:123456789:urgd-pulse-alerts-dev')
    const message = JSON.parse(snsCall.input.Message)
    expect(message.alert).toBe('ses_revision_ready_failure')
    expect(message.tenantId).toBe('tenant-123')
    expect(message.itemId).toBe('item-456')
    expect(message.revisionId).toBe('rev-789')
  })

  it('does not throw when both SES and SNS fail', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant())
    sesSendSpy.mockRejectedValueOnce(new Error('SES error'))
    snsSendSpy.mockRejectedValueOnce(new Error('SNS error'))

    await expect(handler(validEvent)).resolves.not.toThrow()
  })

  // --- Missing tenant record logs error and returns gracefully (Req 3.7) ---

  it('returns gracefully when tenant not found in DynamoDB', async () => {
    dynamoSendSpy.mockResolvedValueOnce({ Item: null })

    await expect(handler(validEvent)).resolves.not.toThrow()
    expect(sesSendSpy).not.toHaveBeenCalled()
    expect(snsSendSpy).not.toHaveBeenCalled()
  })

  it('returns gracefully when tenant has no email attribute', async () => {
    dynamoSendSpy.mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-123' } } })

    await expect(handler(validEvent)).resolves.not.toThrow()
    expect(sesSendSpy).not.toHaveBeenCalled()
  })

  it('returns gracefully when DynamoDB lookup fails', async () => {
    dynamoSendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))

    await expect(handler(validEvent)).resolves.not.toThrow()
    expect(sesSendSpy).not.toHaveBeenCalled()
  })

  // --- Missing required event fields ---

  it('returns early when tenantId is missing', async () => {
    await handler({ itemId: 'item-1', itemName: 'My Item', revisionId: 'rev-1' })
    expect(dynamoSendSpy).not.toHaveBeenCalled()
    expect(sesSendSpy).not.toHaveBeenCalled()
  })

  it('returns early when revisionId is missing', async () => {
    await handler({ tenantId: 'tenant-1', itemId: 'item-1', itemName: 'My Item' })
    expect(dynamoSendSpy).not.toHaveBeenCalled()
    expect(sesSendSpy).not.toHaveBeenCalled()
  })

  it('looks up tenant email from DynamoDB using tenantId', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant())
    sesSendSpy.mockResolvedValueOnce({})

    await handler(validEvent)

    expect(dynamoSendSpy).toHaveBeenCalledTimes(1)
    const dynamoCall = dynamoSendSpy.mock.calls[0][0]
    expect(dynamoCall.input.TableName).toBe('urgd-pulse-tenants-dev')
    expect(dynamoCall.input.Key.tenantId.S).toBe('tenant-123')
  })
})
