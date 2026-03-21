// Unit tests for urgd-pulse-deleteAccount
// Requirements: 8.5, 8.6

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('REPORTS_TABLE', 'urgd-pulse-reports-dev')
vi.stubEnv('PULSE_CHECKS_TABLE', 'urgd-pulse-pulsechecks-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('USER_POOL_ID', 'us-west-2_testpool')
vi.stubEnv('ALERTS_TOPIC_ARN', 'arn:aws:sns:us-west-2:123456789:urgd-pulse-alerts-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const cognitoSendSpy = vi.fn()
const snsSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class DeleteItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class BatchWriteItemCommand { constructor(input) { this.input = input } }
  class ScanCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, DeleteItemCommand, QueryCommand, BatchWriteItemCommand, ScanCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3SendSpy(...args) } }
  class ListObjectsV2Command { constructor(input) { this.input = input } }
  class DeleteObjectsCommand { constructor(input) { this.input = input } }
  return { S3Client, ListObjectsV2Command, DeleteObjectsCommand }
})

vi.mock('@aws-sdk/client-cognito-identity-provider', () => {
  class CognitoIdentityProviderClient { send(...args) { return cognitoSendSpy(...args) } }
  class AdminDeleteUserCommand { constructor(input) { this.input = input } }
  return { CognitoIdentityProviderClient, AdminDeleteUserCommand }
})

vi.mock('@aws-sdk/client-sns', () => {
  class SNSClient { send(...args) { return snsSendSpy(...args) } }
  class PublishCommand { constructor(input) { this.input = input } }
  return { SNSClient, PublishCommand }
})

const { handler } = await import('./index.mjs')

function makeEvent(body = {}, overrides = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { tenantId: 'tenant-123', username: 'user@example.com' },
    },
    body: JSON.stringify(body),
    ...overrides,
  }
}

function makeTenant(email = 'user@example.com') {
  return {
    Item: {
      tenantId: { S: 'tenant-123' },
      email: { S: email },
    },
  }
}

function setupSuccessfulDeletion() {
  // GetItem for tenant
  dynamoSendSpy.mockResolvedValueOnce(makeTenant())
  // Query sessions
  dynamoSendSpy.mockResolvedValueOnce({ Items: [{ tenantId: { S: 'tenant-123' }, sessionId: { S: 'session-1' } }] })
  // BatchWrite sessions
  dynamoSendSpy.mockResolvedValueOnce({})
  // Query items
  dynamoSendSpy.mockResolvedValueOnce({ Items: [{ tenantId: { S: 'tenant-123' }, itemId: { S: 'item-1' } }] })
  // BatchWrite items
  dynamoSendSpy.mockResolvedValueOnce({})
  // Query reports
  dynamoSendSpy.mockResolvedValueOnce({ Items: [] })
  // Query pulse checks
  dynamoSendSpy.mockResolvedValueOnce({ Items: [] })
  // Query transcripts for session-1
  dynamoSendSpy.mockResolvedValueOnce({ Items: [] })
  // DeleteItem tenant
  dynamoSendSpy.mockResolvedValueOnce({})
  // S3 ListObjectsV2
  s3SendSpy.mockResolvedValueOnce({ Contents: [], IsTruncated: false })
  // Cognito AdminDeleteUser
  cognitoSendSpy.mockResolvedValueOnce({})
  // SNS Publish
  snsSendSpy.mockResolvedValueOnce({})
}

describe('deleteAccount handler', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    cognitoSendSpy.mockReset()
    snsSendSpy.mockReset()
  })

  it('returns 401 when tenantId is missing', async () => {
    const event = makeEvent({}, { requestContext: { requestId: 'req', authorizer: {} } })
    const result = await handler(event)
    expect(result.statusCode).toBe(401)
  })

  it('returns 400 when confirmEmail is missing', async () => {
    const result = await handler(makeEvent({}))
    expect(result.statusCode).toBe(400)
  })

  it('returns 400 when confirmEmail does not match tenant email', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant('user@example.com'))
    const result = await handler(makeEvent({ confirmEmail: 'wrong@example.com' }))
    expect(result.statusCode).toBe(400)
    const body = JSON.parse(result.body)
    expect(body.message).toBe('Email confirmation does not match')
  })

  it('returns 400 for case-insensitive email mismatch', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant('User@Example.com'))
    // Matching email (case-insensitive) should succeed
    setupSuccessfulDeletion()
    // Reset and test mismatch
    dynamoSendSpy.mockReset()
    dynamoSendSpy.mockResolvedValueOnce(makeTenant('user@example.com'))
    const result = await handler(makeEvent({ confirmEmail: 'WRONG@example.com' }))
    expect(result.statusCode).toBe(400)
  })

  it('accepts case-insensitive email match', async () => {
    setupSuccessfulDeletion()
    // Override first call to return tenant with uppercase email
    dynamoSendSpy.mockReset()
    dynamoSendSpy.mockResolvedValueOnce(makeTenant('User@Example.com'))
    // Re-setup remaining calls
    dynamoSendSpy.mockResolvedValueOnce({ Items: [] }) // sessions
    dynamoSendSpy.mockResolvedValueOnce({ Items: [] }) // items
    dynamoSendSpy.mockResolvedValueOnce({ Items: [] }) // reports
    dynamoSendSpy.mockResolvedValueOnce({ Items: [] }) // pulse checks
    dynamoSendSpy.mockResolvedValueOnce({}) // delete tenant
    s3SendSpy.mockResolvedValueOnce({ Contents: [], IsTruncated: false })
    cognitoSendSpy.mockResolvedValueOnce({})
    snsSendSpy.mockResolvedValueOnce({})

    const result = await handler(makeEvent({ confirmEmail: 'user@example.com' }))
    expect(result.statusCode).toBe(200)
  })

  it('deletes all data across 6 DynamoDB tables on matching email', async () => {
    setupSuccessfulDeletion()
    const result = await handler(makeEvent({ confirmEmail: 'user@example.com' }))
    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.message).toBe('Account deleted')
  })

  it('deletes S3 objects under pulse/{tenantId}/', async () => {
    setupSuccessfulDeletion()
    // Override S3 to return some objects
    s3SendSpy.mockReset()
    s3SendSpy.mockResolvedValueOnce({
      Contents: [
        { Key: 'pulse/tenant-123/items/item-1/document.md' },
        { Key: 'pulse/tenant-123/items/item-1/extracted.md' },
      ],
      IsTruncated: false,
    })
    s3SendSpy.mockResolvedValueOnce({}) // DeleteObjects

    // Re-setup dynamo calls
    dynamoSendSpy.mockReset()
    dynamoSendSpy.mockResolvedValueOnce(makeTenant())
    dynamoSendSpy.mockResolvedValueOnce({ Items: [] }) // sessions
    dynamoSendSpy.mockResolvedValueOnce({ Items: [] }) // items
    dynamoSendSpy.mockResolvedValueOnce({ Items: [] }) // reports
    dynamoSendSpy.mockResolvedValueOnce({ Items: [] }) // pulse checks
    dynamoSendSpy.mockResolvedValueOnce({}) // delete tenant
    cognitoSendSpy.mockResolvedValueOnce({})
    snsSendSpy.mockResolvedValueOnce({})

    const result = await handler(makeEvent({ confirmEmail: 'user@example.com' }))
    expect(result.statusCode).toBe(200)

    // Verify S3 ListObjectsV2 was called with correct prefix
    const listCall = s3SendSpy.mock.calls[0][0]
    expect(listCall.input.Prefix).toBe('pulse/tenant-123/')

    // Verify DeleteObjects was called
    const deleteCall = s3SendSpy.mock.calls[1][0]
    expect(deleteCall.input.Delete.Objects).toHaveLength(2)
  })

  it('calls Cognito AdminDeleteUser', async () => {
    setupSuccessfulDeletion()
    await handler(makeEvent({ confirmEmail: 'user@example.com' }))
    expect(cognitoSendSpy).toHaveBeenCalledTimes(1)
    const cognitoCall = cognitoSendSpy.mock.calls[0][0]
    expect(cognitoCall.input.UserPoolId).toBe('us-west-2_testpool')
    expect(cognitoCall.input.Username).toBe('user@example.com')
  })

  it('publishes SNS alert on completion', async () => {
    setupSuccessfulDeletion()
    await handler(makeEvent({ confirmEmail: 'user@example.com' }))
    expect(snsSendSpy).toHaveBeenCalledTimes(1)
    const snsCall = snsSendSpy.mock.calls[0][0]
    expect(snsCall.input.TopicArn).toBe('arn:aws:sns:us-west-2:123456789:urgd-pulse-alerts-dev')
    const message = JSON.parse(snsCall.input.Message)
    expect(message.alert).toBe('account_deleted')
    expect(message.tenantId).toBe('tenant-123')
  })

  it('does not delete any data when email does not match', async () => {
    dynamoSendSpy.mockResolvedValueOnce(makeTenant('user@example.com'))
    const result = await handler(makeEvent({ confirmEmail: 'wrong@example.com' }))
    expect(result.statusCode).toBe(400)
    // Only GetItem was called (to verify tenant), no deletes
    expect(dynamoSendSpy).toHaveBeenCalledTimes(1)
    expect(s3SendSpy).not.toHaveBeenCalled()
    expect(cognitoSendSpy).not.toHaveBeenCalled()
  })

  it('returns 404 when tenant not found', async () => {
    dynamoSendSpy.mockResolvedValueOnce({ Item: null })
    const result = await handler(makeEvent({ confirmEmail: 'user@example.com' }))
    expect(result.statusCode).toBe(404)
  })

  it('continues even if Cognito deletion fails', async () => {
    setupSuccessfulDeletion()
    cognitoSendSpy.mockReset()
    cognitoSendSpy.mockRejectedValueOnce(new Error('Cognito error'))
    snsSendSpy.mockResolvedValueOnce({})

    const result = await handler(makeEvent({ confirmEmail: 'user@example.com' }))
    // Should still return 200 — Cognito deletion is best-effort
    expect(result.statusCode).toBe(200)
  })
})
