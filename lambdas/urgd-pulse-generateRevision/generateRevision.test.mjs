// Unit tests for urgd-pulse-generateRevision (async kick-off pattern)
// Requirements: 1.1, 1.2, 1.3, 1.4, 1.6

import { describe, it, expect, vi, beforeEach } from 'vitest'

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

function makeEvent(overrides = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { tenantId: 'tenant-123' },
    },
    pathParameters: { itemId: 'item-456' },
    ...overrides,
  }
}

/** Sets up dynamo mocks for tenant + SYSTEM feature flag lookup */
function mockFeatureFlag(flagValue) {
  // First call: tenant record
  dynamoSendSpy.mockResolvedValueOnce({
    Item: {
      tenantId: { S: 'tenant-123' },
      features: { M: { itemRevisionLoop: { BOOL: flagValue } } },
    },
  })
  // Second call: SYSTEM record (no maintenance flags)
  dynamoSendSpy.mockResolvedValueOnce({})
}

function makePulseCheck(status = 'complete') {
  return {
    Item: {
      tenantId: { S: 'tenant-123' },
      itemId: { S: 'item-456' },
      status: { S: status },
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

/** Sets up all mocks for a successful happy path through validation + PutItem + Lambda invoke */
function mockHappyPath() {
  mockFeatureFlag(true)
  dynamoSendSpy.mockResolvedValueOnce(makePulseCheck('complete')) // pulse check
  dynamoSendSpy.mockResolvedValueOnce({}) // PutItem revision record
}

describe('generateRevision handler (async kick-off)', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    lambdaSendSpy.mockReset()
    lambdaSendSpy.mockResolvedValue({})
  })

  it('returns 401 when tenantId is missing', async () => {
    const event = makeEvent({ requestContext: { requestId: 'req', authorizer: {} } })
    const result = await handler(event)
    expect(result.statusCode).toBe(401)
  })

  it('returns 400 when itemId is missing', async () => {
    const event = makeEvent({ pathParameters: {} })
    const result = await handler(event)
    expect(result.statusCode).toBe(400)
  })

  it('returns 403 when itemRevisionLoop flag is false', async () => {
    mockFeatureFlag(false)
    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(403)
  })

  it('returns 409 when no completed pulse check exists', async () => {
    mockFeatureFlag(true)
    dynamoSendSpy.mockResolvedValueOnce({ Item: null })
    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(409)
  })

  it('returns 409 when pulse check is not complete', async () => {
    mockFeatureFlag(true)
    dynamoSendSpy.mockResolvedValueOnce(makePulseCheck('generating'))
    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(409)
  })

  it('returns 409 when no accepted/revised decisions', async () => {
    mockFeatureFlag(true)
    dynamoSendSpy.mockResolvedValueOnce({
      Item: {
        tenantId: { S: 'tenant-123' },
        itemId: { S: 'item-456' },
        status: { S: 'complete' },
        decisions: { M: { 'rev-1': { M: { action: { S: 'Dismiss' } } } } },
        proposedRevisions: { L: [{ M: { revisionId: { S: 'rev-1' }, proposal: { S: 'x' } } }] },
      },
    })
    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(409)
    const body = JSON.parse(result.body)
    expect(body.message).toMatch(/no accepted or revised decisions/i)
  })

  it('returns 202 with revisionId and status on happy path', async () => {
    mockHappyPath()

    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(202)

    const body = JSON.parse(result.body)
    expect(body.data.revisionId).toBeTruthy()
    expect(body.data.status).toBe('generating')
  })

  it('writes revision record to DynamoDB on happy path', async () => {
    mockHappyPath()

    await handler(makeEvent())

    // Find the PutItem call — it's the 4th dynamo call (tenant, system, pulseCheck, PutItem)
    const putCall = dynamoSendSpy.mock.calls.find(
      call => call[0].name === 'PutItemCommand' && call[0].input.TableName === 'urgd-pulse-revisions-dev'
    )
    expect(putCall).toBeTruthy()
    expect(putCall[0].input.Item.status.S).toBe('generating')
    expect(putCall[0].input.Item.tenantId.S).toBe('tenant-123')
    expect(putCall[0].input.Item.itemId.S).toBe('item-456')
    expect(putCall[0].input.Item.decisionsApplied.N).toBe('1')
  })

  it('invokes processRevision Lambda asynchronously on happy path', async () => {
    mockHappyPath()

    await handler(makeEvent())

    expect(lambdaSendSpy).toHaveBeenCalledOnce()
    const invokeCall = lambdaSendSpy.mock.calls[0][0]
    expect(invokeCall.input.FunctionName).toBe('urgd-pulse-processRevision-dev')
    expect(invokeCall.input.InvocationType).toBe('Event')
    const payload = JSON.parse(invokeCall.input.Payload)
    expect(payload.tenantId).toBe('tenant-123')
    expect(payload.itemId).toBe('item-456')
    expect(payload.revisionId).toBeTruthy()
    expect(payload.startedAt).toBeTruthy()
  })

  it('returns 500 and marks revision failed when Lambda invocation fails', async () => {
    mockHappyPath()
    dynamoSendSpy.mockResolvedValueOnce({}) // UpdateItem to mark failed
    lambdaSendSpy.mockRejectedValueOnce(new Error('Lambda invocation failed'))

    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(500)

    // Verify UpdateItem was called to mark revision as failed
    const updateCall = dynamoSendSpy.mock.calls.find(
      call => call[0].name === 'UpdateItemCommand' && call[0].input.TableName === 'urgd-pulse-revisions-dev'
    )
    expect(updateCall).toBeTruthy()
    expect(updateCall[0].input.ExpressionAttributeValues[':failed'].S).toBe('failed')
  })

  it('returns 500 when DynamoDB PutItem fails without invoking worker', async () => {
    mockFeatureFlag(true)
    dynamoSendSpy.mockResolvedValueOnce(makePulseCheck('complete')) // pulse check
    dynamoSendSpy.mockRejectedValueOnce(new Error('DynamoDB PutItem failed')) // PutItem fails

    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(500)

    // Worker should NOT have been invoked
    expect(lambdaSendSpy).not.toHaveBeenCalled()
  })
})
