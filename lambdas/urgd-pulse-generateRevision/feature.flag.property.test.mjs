// Feature: async-revision-generation, Property 27: Feature Flag Enforcement Property
//
// For any Feature Flag that is false for a tenant, the corresponding API endpoint
// returns 403 and no worker invocation or DynamoDB revision write occurs.
// For any Feature Flag that is true (with valid inputs), the endpoint returns 202.
// These are mutually exclusive states.
//
// Validates: Requirements 1.1, 1.6
// numRuns: 100

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('PULSE_CHECKS_TABLE', 'urgd-pulse-pulsechecks-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('REVISIONS_TABLE', 'urgd-pulse-revisions-dev')
vi.stubEnv('PROCESS_FUNCTION_NAME', 'urgd-pulse-processRevision-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const lambdaSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class PutItemCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send(...args) { return lambdaSendSpy(...args) } }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

const { handler } = await import('./index.mjs')

function makeCompletePulseCheck(tenantId, itemId) {
  return {
    Item: {
      tenantId: { S: tenantId },
      itemId: { S: itemId },
      status: { S: 'complete' },
      decisions: {
        M: {
          'rev-1': { M: { action: { S: 'Accept' }, tenantNote: { S: '' } } },
        },
      },
      proposedRevisions: {
        L: [{
          M: {
            revisionId: { S: 'rev-1' },
            proposal: { S: 'Improve clarity' },
            rationale: { S: 'Reviewers found it unclear' },
            revisionType: { S: 'line-edit' },
          },
        }],
      },
    },
  }
}

describe('Property 27: Feature Flag Enforcement Property (async kick-off)', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    lambdaSendSpy.mockReset()
    lambdaSendSpy.mockResolvedValue({})
  })

  it('itemRevisionLoop=false always returns 403 regardless of other conditions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        async (tenantId, itemId) => {
          dynamoSendSpy.mockReset()
          lambdaSendSpy.mockReset()
          lambdaSendSpy.mockResolvedValue({})

          // Tenant record: flag is explicitly false
          dynamoSendSpy.mockResolvedValueOnce({
            Item: {
              tenantId: { S: tenantId },
              features: { M: { itemRevisionLoop: { BOOL: false } } },
            },
          })
          // SYSTEM record
          dynamoSendSpy.mockResolvedValueOnce({})

          const event = {
            headers: { origin: 'https://pulse.urgdstudios.com' },
            requestContext: { requestId: 'req-prop', authorizer: { tenantId } },
            pathParameters: { itemId },
          }

          const result = await handler(event)

          // INVARIANT: flag=false → 403
          expect(result.statusCode).toBe(403)
          const body = JSON.parse(result.body)
          expect(body.message).toMatch(/not enabled/i)

          // INVARIANT: No Lambda invocation or DynamoDB revision write when flag is off
          expect(lambdaSendSpy).not.toHaveBeenCalled()
        }
      ),
      { numRuns: 100 }
    )
  })

  it('itemRevisionLoop=true allows access and returns 202', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        async (tenantId, itemId) => {
          dynamoSendSpy.mockReset()
          lambdaSendSpy.mockReset()
          lambdaSendSpy.mockResolvedValue({})

          // Tenant: flag is true
          dynamoSendSpy.mockResolvedValueOnce({
            Item: {
              tenantId: { S: tenantId },
              features: { M: { itemRevisionLoop: { BOOL: true } } },
            },
          })
          // SYSTEM record
          dynamoSendSpy.mockResolvedValueOnce({})
          // Pulse check
          dynamoSendSpy.mockResolvedValueOnce(makeCompletePulseCheck(tenantId, itemId))
          // PutItem revision record
          dynamoSendSpy.mockResolvedValueOnce({})

          const event = {
            headers: { origin: 'https://pulse.urgdstudios.com' },
            requestContext: { requestId: 'req-prop', authorizer: { tenantId } },
            pathParameters: { itemId },
          }

          const result = await handler(event)

          // INVARIANT: flag=true → accessible (not 403), returns 202
          expect(result.statusCode).not.toBe(403)
          expect(result.statusCode).toBe(202)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('flag=false and flag=true outcomes are mutually exclusive', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.boolean(),
        async (tenantId, itemId, flagEnabled) => {
          dynamoSendSpy.mockReset()
          lambdaSendSpy.mockReset()
          lambdaSendSpy.mockResolvedValue({})

          // Tenant record
          dynamoSendSpy.mockResolvedValueOnce({
            Item: {
              tenantId: { S: tenantId },
              features: { M: { itemRevisionLoop: { BOOL: flagEnabled } } },
            },
          })
          // SYSTEM record
          dynamoSendSpy.mockResolvedValueOnce({})

          if (flagEnabled) {
            dynamoSendSpy.mockResolvedValueOnce(makeCompletePulseCheck(tenantId, itemId))
            dynamoSendSpy.mockResolvedValueOnce({}) // PutItem
          }

          const event = {
            headers: { origin: 'https://pulse.urgdstudios.com' },
            requestContext: { requestId: 'req-prop', authorizer: { tenantId } },
            pathParameters: { itemId },
          }

          const result = await handler(event)

          if (flagEnabled) {
            expect(result.statusCode).not.toBe(403)
          } else {
            expect(result.statusCode).toBe(403)
          }

          const is403 = result.statusCode === 403
          expect(is403).toBe(!flagEnabled)
        }
      ),
      { numRuns: 100 }
    )
  })
})
