// Feature: async-revision-generation, Property 2: Kick-off happy path produces correct response, record, and invocation
//
// For any valid input (present tenantId, present itemId, feature flag enabled,
// completed pulse check with at least one accepted/revised decision), the kick-off Lambda
// SHALL return HTTP 202 with a response containing a valid UUID revisionId and status 'generating',
// SHALL write a revision record to the Revisions table with status 'generating' and all required attributes,
// AND SHALL invoke the worker Lambda with InvocationType 'Event' and a payload containing
// tenantId, itemId, revisionId, and startedAt.
//
// **Validates: Requirements 1.2, 1.3**
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
  class GetItemCommand { constructor(input) { this.input = input; this.name = 'GetItemCommand' } }
  class PutItemCommand { constructor(input) { this.input = input; this.name = 'PutItemCommand' } }
  class UpdateItemCommand { constructor(input) { this.input = input; this.name = 'UpdateItemCommand' } }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send(...args) { return lambdaSendSpy(...args) } }
  class InvokeCommand { constructor(input) { this.input = input; this.name = 'InvokeCommand' } }
  return { LambdaClient, InvokeCommand }
})

const { handler } = await import('./index.mjs')

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Generator for valid inputs with 1–5 accepted/revised decisions
const validInputArb = fc.record({
  tenantId: fc.uuid(),
  itemId: fc.uuid(),
  decisionCount: fc.integer({ min: 1, max: 5 }),
  action: fc.constantFrom('Accept', 'Revise'),
})

describe('Property 2: Kick-off happy path produces correct response, record, and invocation', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    lambdaSendSpy.mockReset()
    lambdaSendSpy.mockResolvedValue({})
  })

  it('valid inputs produce 202 with correct response, DynamoDB record, and Lambda invocation', async () => {
    await fc.assert(
      fc.asyncProperty(
        validInputArb,
        async ({ tenantId, itemId, decisionCount, action }) => {
          dynamoSendSpy.mockReset()
          lambdaSendSpy.mockReset()
          lambdaSendSpy.mockResolvedValue({})

          // Build decisions and proposedRevisions
          const decisions = {}
          const proposedRevisions = []
          for (let i = 0; i < decisionCount; i++) {
            const revId = `rev-${i}`
            decisions[revId] = { M: { action: { S: action }, tenantNote: { S: '' } } }
            proposedRevisions.push({
              M: {
                revisionId: { S: revId },
                proposal: { S: `Proposal ${i}` },
                rationale: { S: `Rationale ${i}` },
                revisionType: { S: 'line-edit' },
              },
            })
          }

          // Tenant record: flag on
          dynamoSendSpy.mockResolvedValueOnce({
            Item: {
              tenantId: { S: tenantId },
              features: { M: { itemRevisionLoop: { BOOL: true } } },
            },
          })
          // SYSTEM record
          dynamoSendSpy.mockResolvedValueOnce({})
          // Pulse check: complete with decisions
          dynamoSendSpy.mockResolvedValueOnce({
            Item: {
              tenantId: { S: tenantId },
              itemId: { S: itemId },
              status: { S: 'complete' },
              decisions: { M: decisions },
              proposedRevisions: { L: proposedRevisions },
            },
          })
          // PutItem revision record
          dynamoSendSpy.mockResolvedValueOnce({})

          const event = {
            headers: { origin: 'https://pulse.urgdstudios.com' },
            requestContext: { requestId: 'req-prop', authorizer: { tenantId } },
            pathParameters: { itemId },
          }

          const result = await handler(event)

          // INVARIANT 1: HTTP 202 response
          expect(result.statusCode).toBe(202)

          // INVARIANT 2: Response contains valid UUID revisionId and status 'generating'
          const body = JSON.parse(result.body)
          expect(body.data.revisionId).toMatch(UUID_REGEX)
          expect(body.data.status).toBe('generating')

          // INVARIANT 3: DynamoDB PutItem with correct attributes
          const putCall = dynamoSendSpy.mock.calls.find(
            call => call[0].name === 'PutItemCommand' &&
                    call[0].input.TableName === 'urgd-pulse-revisions-dev'
          )
          expect(putCall).toBeTruthy()
          const item = putCall[0].input.Item
          expect(item.tenantId.S).toBe(tenantId)
          expect(item.revisionId.S).toMatch(UUID_REGEX)
          expect(item.itemId.S).toBe(itemId)
          expect(item.status.S).toBe('generating')
          expect(item.createdAt.S).toBeTruthy()
          expect(item.decisionsApplied.N).toBe(String(decisionCount))

          // INVARIANT 4: Lambda invoked with correct payload
          expect(lambdaSendSpy).toHaveBeenCalledOnce()
          const invokeCall = lambdaSendSpy.mock.calls[0][0]
          expect(invokeCall.input.FunctionName).toBe('urgd-pulse-processRevision-dev')
          expect(invokeCall.input.InvocationType).toBe('Event')
          const payload = JSON.parse(invokeCall.input.Payload)
          expect(payload.tenantId).toBe(tenantId)
          expect(payload.itemId).toBe(itemId)
          expect(payload.revisionId).toMatch(UUID_REGEX)
          expect(payload.startedAt).toBeTruthy()

          // INVARIANT 5: revisionId in response matches DynamoDB record and Lambda payload
          expect(body.data.revisionId).toBe(item.revisionId.S)
          expect(body.data.revisionId).toBe(payload.revisionId)
        }
      ),
      { numRuns: 100 }
    )
  })
})
