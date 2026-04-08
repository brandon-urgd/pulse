// Feature: async-revision-generation, Property 1: Kick-off validation rejects invalid inputs without side effects
//
// For any combination of invalid input states (missing tenantId, missing itemId,
// feature flag off/maintenance, no completed pulse check, no accepted decisions),
// the kick-off Lambda SHALL return the correct HTTP error code (401, 400, 403, 503, or 409)
// AND SHALL NOT invoke the worker Lambda or write a revision record to DynamoDB.
//
// **Validates: Requirements 1.1, 1.6**
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

// Generator for invalid input scenarios
const invalidScenarioArb = fc.oneof(
  // Missing tenantId
  fc.record({
    type: fc.constant('missing_tenantId'),
    itemId: fc.uuid(),
  }),
  // Missing itemId
  fc.record({
    type: fc.constant('missing_itemId'),
    tenantId: fc.uuid(),
  }),
  // Feature flag off
  fc.record({
    type: fc.constant('flag_off'),
    tenantId: fc.uuid(),
    itemId: fc.uuid(),
  }),
  // Feature under maintenance (system-level)
  fc.record({
    type: fc.constant('maintenance'),
    tenantId: fc.uuid(),
    itemId: fc.uuid(),
  }),
  // No completed pulse check
  fc.record({
    type: fc.constant('no_pulse_check'),
    tenantId: fc.uuid(),
    itemId: fc.uuid(),
    pulseStatus: fc.constantFrom('generating', 'failed', null),
  }),
  // No accepted/revised decisions
  fc.record({
    type: fc.constant('no_accepted_decisions'),
    tenantId: fc.uuid(),
    itemId: fc.uuid(),
    action: fc.constantFrom('Dismiss', 'Skip', 'Ignore'),
  }),
)

describe('Property 1: Kick-off validation rejects invalid inputs without side effects', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    lambdaSendSpy.mockReset()
    lambdaSendSpy.mockResolvedValue({})
  })

  it('invalid inputs produce correct error codes and no side effects', async () => {
    await fc.assert(
      fc.asyncProperty(
        invalidScenarioArb,
        async (scenario) => {
          dynamoSendSpy.mockReset()
          lambdaSendSpy.mockReset()
          lambdaSendSpy.mockResolvedValue({})

          let event
          let expectedStatus

          switch (scenario.type) {
            case 'missing_tenantId':
              event = {
                headers: { origin: 'https://pulse.urgdstudios.com' },
                requestContext: { requestId: 'req', authorizer: {} },
                pathParameters: { itemId: scenario.itemId },
              }
              expectedStatus = 401
              break

            case 'missing_itemId':
              event = {
                headers: { origin: 'https://pulse.urgdstudios.com' },
                requestContext: { requestId: 'req', authorizer: { tenantId: scenario.tenantId } },
                pathParameters: {},
              }
              expectedStatus = 400
              break

            case 'flag_off':
              dynamoSendSpy.mockResolvedValueOnce({
                Item: {
                  tenantId: { S: scenario.tenantId },
                  features: { M: { itemRevisionLoop: { BOOL: false } } },
                },
              })
              dynamoSendSpy.mockResolvedValueOnce({}) // SYSTEM record
              event = {
                headers: { origin: 'https://pulse.urgdstudios.com' },
                requestContext: { requestId: 'req', authorizer: { tenantId: scenario.tenantId } },
                pathParameters: { itemId: scenario.itemId },
              }
              expectedStatus = 403
              break

            case 'maintenance':
              dynamoSendSpy.mockResolvedValueOnce({
                Item: {
                  tenantId: { S: scenario.tenantId },
                  features: { M: { itemRevisionLoop: { BOOL: true } } },
                },
              })
              dynamoSendSpy.mockResolvedValueOnce({
                Item: {
                  tenantId: { S: 'SYSTEM' },
                  serviceFlags: {
                    M: {
                      itemRevisionLoop: { M: { status: { S: 'maintenance' } } },
                    },
                  },
                },
              })
              event = {
                headers: { origin: 'https://pulse.urgdstudios.com' },
                requestContext: { requestId: 'req', authorizer: { tenantId: scenario.tenantId } },
                pathParameters: { itemId: scenario.itemId },
              }
              expectedStatus = 503
              break

            case 'no_pulse_check':
              dynamoSendSpy.mockResolvedValueOnce({
                Item: {
                  tenantId: { S: scenario.tenantId },
                  features: { M: { itemRevisionLoop: { BOOL: true } } },
                },
              })
              dynamoSendSpy.mockResolvedValueOnce({}) // SYSTEM
              if (scenario.pulseStatus === null) {
                dynamoSendSpy.mockResolvedValueOnce({ Item: null })
              } else {
                dynamoSendSpy.mockResolvedValueOnce({
                  Item: {
                    tenantId: { S: scenario.tenantId },
                    itemId: { S: scenario.itemId },
                    status: { S: scenario.pulseStatus },
                  },
                })
              }
              event = {
                headers: { origin: 'https://pulse.urgdstudios.com' },
                requestContext: { requestId: 'req', authorizer: { tenantId: scenario.tenantId } },
                pathParameters: { itemId: scenario.itemId },
              }
              expectedStatus = 409
              break

            case 'no_accepted_decisions':
              dynamoSendSpy.mockResolvedValueOnce({
                Item: {
                  tenantId: { S: scenario.tenantId },
                  features: { M: { itemRevisionLoop: { BOOL: true } } },
                },
              })
              dynamoSendSpy.mockResolvedValueOnce({}) // SYSTEM
              dynamoSendSpy.mockResolvedValueOnce({
                Item: {
                  tenantId: { S: scenario.tenantId },
                  itemId: { S: scenario.itemId },
                  status: { S: 'complete' },
                  decisions: { M: { 'rev-1': { M: { action: { S: scenario.action } } } } },
                  proposedRevisions: { L: [{ M: { revisionId: { S: 'rev-1' }, proposal: { S: 'x' } } }] },
                },
              })
              event = {
                headers: { origin: 'https://pulse.urgdstudios.com' },
                requestContext: { requestId: 'req', authorizer: { tenantId: scenario.tenantId } },
                pathParameters: { itemId: scenario.itemId },
              }
              expectedStatus = 409
              break
          }

          const result = await handler(event)

          // INVARIANT: Correct error status code
          expect(result.statusCode).toBe(expectedStatus)

          // INVARIANT: No worker Lambda invocation
          expect(lambdaSendSpy).not.toHaveBeenCalled()

          // INVARIANT: No PutItem to Revisions table
          const putItemCalls = dynamoSendSpy.mock.calls.filter(
            call => call[0].name === 'PutItemCommand' &&
                    call[0].input.TableName === 'urgd-pulse-revisions-dev'
          )
          expect(putItemCalls).toHaveLength(0)
        }
      ),
      { numRuns: 100 }
    )
  })
})
