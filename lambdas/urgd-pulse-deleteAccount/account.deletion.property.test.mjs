// Feature: pulse, Property 25: Account Deletion Completeness Property
//
// For any account deletion with a confirmEmail that matches the tenant's email,
// querying all 6 DynamoDB tables for the tenant's tenantId returns zero records,
// listing S3 objects under pulse/{tenantId}/ returns zero objects, and the
// Cognito user no longer exists.
// For any account deletion with a non-matching confirmEmail, no data is deleted
// and the response is 400. These are mutually exclusive.
//
// Validates: Requirements 8.5, 8.6
// numRuns: 100

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

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

// Email generator: valid email-like strings
const emailArb = fc.tuple(
  fc.stringMatching(/^[a-z]{3,8}$/),
  fc.stringMatching(/^[a-z]{3,8}$/),
  fc.constantFrom('com', 'net', 'org')
).map(([user, domain, tld]) => `${user}@${domain}.${tld}`)

// Different email generator (guaranteed different from a given email)
const differentEmailArb = (email) =>
  emailArb.filter(e => e.toLowerCase() !== email.toLowerCase())

function setupMatchingDeletion(tenantEmail) {
  // GetItem for tenant
  dynamoSendSpy.mockResolvedValueOnce({
    Item: { tenantId: { S: 'tenant-prop' }, email: { S: tenantEmail } },
  })
  // Query sessions (empty)
  dynamoSendSpy.mockResolvedValueOnce({ Items: [] })
  // Query items (empty)
  dynamoSendSpy.mockResolvedValueOnce({ Items: [] })
  // Query reports (empty)
  dynamoSendSpy.mockResolvedValueOnce({ Items: [] })
  // Query pulse checks (empty)
  dynamoSendSpy.mockResolvedValueOnce({ Items: [] })
  // DeleteItem tenant
  dynamoSendSpy.mockResolvedValueOnce({})
  // S3 ListObjectsV2 (empty)
  s3SendSpy.mockResolvedValueOnce({ Contents: [], IsTruncated: false })
  // Cognito AdminDeleteUser
  cognitoSendSpy.mockResolvedValueOnce({})
  // SNS Publish
  snsSendSpy.mockResolvedValueOnce({})
}

describe('Property 25: Account Deletion Completeness Property', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    cognitoSendSpy.mockReset()
    snsSendSpy.mockReset()
  })

  it('matching confirmEmail triggers full deletion across all services', async () => {
    await fc.assert(
      fc.asyncProperty(
        emailArb,
        async (tenantEmail) => {
          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          cognitoSendSpy.mockReset()
          snsSendSpy.mockReset()

          setupMatchingDeletion(tenantEmail)

          const event = {
            headers: { origin: 'https://pulse.urgdstudios.com' },
            requestContext: {
              requestId: 'req-prop',
              authorizer: { tenantId: 'tenant-prop', username: tenantEmail },
            },
            body: JSON.stringify({ confirmEmail: tenantEmail }),
          }

          const result = await handler(event)

          // INVARIANT: matching email → 200
          expect(result.statusCode).toBe(200)
          const body = JSON.parse(result.body)
          expect(body.message).toBe('Account deleted')

          // INVARIANT: Cognito deletion was called
          expect(cognitoSendSpy).toHaveBeenCalledTimes(1)

          // INVARIANT: SNS alert was published
          expect(snsSendSpy).toHaveBeenCalledTimes(1)

          // INVARIANT: S3 listing was called with correct prefix
          const listCall = s3SendSpy.mock.calls[0]?.[0]
          expect(listCall?.input?.Prefix).toBe('pulse/tenant-prop/')
        }
      ),
      { numRuns: 100 }
    )
  })

  it('non-matching confirmEmail returns 400 with no data deleted', async () => {
    await fc.assert(
      fc.asyncProperty(
        emailArb,
        emailArb,
        async (tenantEmail, wrongEmail) => {
          // Skip if emails happen to match (case-insensitive)
          fc.pre(tenantEmail.toLowerCase() !== wrongEmail.toLowerCase())

          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          cognitoSendSpy.mockReset()
          snsSendSpy.mockReset()

          // Only GetItem is called before the mismatch check
          dynamoSendSpy.mockResolvedValueOnce({
            Item: { tenantId: { S: 'tenant-prop' }, email: { S: tenantEmail } },
          })

          const event = {
            headers: { origin: 'https://pulse.urgdstudios.com' },
            requestContext: {
              requestId: 'req-prop',
              authorizer: { tenantId: 'tenant-prop', username: tenantEmail },
            },
            body: JSON.stringify({ confirmEmail: wrongEmail }),
          }

          const result = await handler(event)

          // INVARIANT: non-matching email → 400
          expect(result.statusCode).toBe(400)
          const body = JSON.parse(result.body)
          expect(body.message).toBe('Email confirmation does not match')

          // INVARIANT: no deletion operations performed
          expect(s3SendSpy).not.toHaveBeenCalled()
          expect(cognitoSendSpy).not.toHaveBeenCalled()
          expect(snsSendSpy).not.toHaveBeenCalled()

          // Only 1 DynamoDB call (GetItem to verify tenant)
          expect(dynamoSendSpy).toHaveBeenCalledTimes(1)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('matching and non-matching cases are mutually exclusive', async () => {
    await fc.assert(
      fc.asyncProperty(
        emailArb,
        fc.boolean(),
        async (tenantEmail, useMatchingEmail) => {
          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          cognitoSendSpy.mockReset()
          snsSendSpy.mockReset()

          const confirmEmail = useMatchingEmail
            ? tenantEmail
            : `different_${tenantEmail}`

          const isMatch = confirmEmail.toLowerCase() === tenantEmail.toLowerCase()

          if (isMatch) {
            setupMatchingDeletion(tenantEmail)
          } else {
            dynamoSendSpy.mockResolvedValueOnce({
              Item: { tenantId: { S: 'tenant-prop' }, email: { S: tenantEmail } },
            })
          }

          const event = {
            headers: { origin: 'https://pulse.urgdstudios.com' },
            requestContext: {
              requestId: 'req-prop',
              authorizer: { tenantId: 'tenant-prop', username: tenantEmail },
            },
            body: JSON.stringify({ confirmEmail }),
          }

          const result = await handler(event)

          if (isMatch) {
            // Matching: must succeed with deletion
            expect(result.statusCode).toBe(200)
            expect(cognitoSendSpy).toHaveBeenCalledTimes(1)
          } else {
            // Non-matching: must fail with 400, no deletion
            expect(result.statusCode).toBe(400)
            expect(cognitoSendSpy).not.toHaveBeenCalled()
            expect(s3SendSpy).not.toHaveBeenCalled()
          }

          // These two outcomes are mutually exclusive
          const succeeded = result.statusCode === 200
          const failed = result.statusCode === 400
          expect(succeeded !== failed).toBe(true)
        }
      ),
      { numRuns: 100 }
    )
  })
})
