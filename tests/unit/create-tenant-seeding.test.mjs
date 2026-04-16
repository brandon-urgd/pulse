// Unit tests for createTenant example seeding
// Tests: successful seeding, seeding failure (tenant still created)
// **Validates: Requirements 6.1, 6.9**

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockDynamoSend = vi.fn()
const mockS3Send = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(cmd) { return mockDynamoSend(cmd) } }
  class PutItemCommand { constructor(input) { this.input = input; this._type = 'PutItem' } }
  class BatchWriteItemCommand { constructor(input) { this.input = input; this._type = 'BatchWrite' } }
  class UpdateItemCommand { constructor(input) { this.input = input; this._type = 'UpdateItem' } }
  return { DynamoDBClient, PutItemCommand, BatchWriteItemCommand, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(cmd) { return mockS3Send(cmd) } }
  class PutObjectCommand { constructor(input) { this.input = input; this._type = 'PutObject' } }
  return { S3Client, PutObjectCommand }
})

vi.mock('@aws-sdk/client-ssm', () => {
  class SSMClient { send() { return Promise.resolve({}) } }
  class GetParameterCommand { constructor(input) { this.input = input } }
  return { SSMClient, GetParameterCommand }
})

vi.mock('./shared/utils.mjs', () => ({
  log: vi.fn(),
  requireEnv: vi.fn(),
  createResponse: (code, data, headers, origin) => ({
    statusCode: code,
    body: JSON.stringify(data),
  }),
  errorResponse: (code, msg, details, origin) => ({
    statusCode: code,
    body: JSON.stringify({ error: true, message: msg }),
  }),
}))

vi.mock('./shared/tiers.mjs', () => ({
  getTierDefaults: () => ({
    maxActiveItems: 3,
    maxSessionsPerItem: 5,
    publicSessions: true,
    selfReview: false,
    aiReports: true,
    pulseCheck: true,
    emailReminders: false,
    maxDocumentPages: 10,
    maxUploadSizeMb: 5,
    sessionTimeLimitMinutes: 30,
    itemRevisionLoop: false,
  }),
}))

// Mock ulid
vi.mock('ulid', () => ({
  ulid: vi.fn(() => 'MOCK_ULID_' + Math.random().toString(36).slice(2, 8)),
}))

// Mock fs to provide fixture data
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify({
    item: {
      itemName: 'Example Product Concept',
      description: 'A sample product for exploring Pulse.',
      status: 'closed',
      itemType: 'document',
      documentStatus: 'processed',
      sessionCount: 1,
      totalSections: 4,
      recommendedTimeLimitMinutes: 17,
      sectionMap: {
        sections: [
          { id: 'sec-1', title: 'Introduction', classification: 'substantive' },
          { id: 'sec-2', title: 'Market Analysis', classification: 'substantive' },
        ],
        totalSubstantiveSections: 2,
      },
      feedbackSections: ['sec-1', 'sec-2'],
      sectionDepthPreferences: { 'sec-1': 'deep', 'sec-2': 'standard' },
      coverageMap: {
        'sec-1': { sessionCount: 1, avgDepth: 'deep' },
        'sec-2': { sessionCount: 1, avgDepth: 'standard' },
      },
    },
    session: {
      reviewerName: 'Alex Rivera',
      status: 'completed',
      timeLimitMinutes: 30,
      totalSections: 4,
    },
    transcript: [
      { role: 'assistant', content: 'Welcome to your feedback session.' },
      { role: 'user', content: 'Thanks, happy to be here.' },
    ],
    report: {
      verdict: 'promising',
      conviction: ['Strong product vision'],
      tension: ['Pricing unclear'],
      uncertainty: ['Market fit'],
      energy: 'high',
      conversationShape: 'exploratory',
      themes: ['Innovation', 'Pricing'],
      isSelfReview: false,
      incomplete: false,
    },
    pulseCheck: {
      verdict: 'promising',
      narrative: 'Reviewers see strong potential.',
      themes: [
        {
          themeId: 'theme-innovation',
          label: 'Innovation',
          reviewerSignals: [{ signalType: 'conviction', quote: 'Great idea' }],
        },
      ],
      sharedConviction: ['Strong vision'],
      repeatedTension: ['Pricing'],
      openQuestions: ['Market size?'],
      reviewerVerdicts: [{ verdict: 'promising', energy: 'high', isSelfReview: false }],
      proposedRevisions: [
        {
          revisionId: 'rev-1',
          proposal: 'Clarify pricing',
          rationale: 'Add pricing section',
          revisionType: 'line-edit',
          sourceThemeIds: ['theme-innovation'],
        },
      ],
      sessionCount: 1,
      incompleteCount: 0,
      status: 'completed',
    },
    documentContent: '# Example Document\n\nThis is a sample document.',
  })),
}))

beforeEach(() => {
  mockDynamoSend.mockReset()
  mockS3Send.mockReset()
  process.env.TENANTS_TABLE = 'tenants'
  process.env.ITEMS_TABLE = 'items'
  process.env.SESSIONS_TABLE = 'sessions'
  process.env.TRANSCRIPTS_TABLE = 'transcripts'
  process.env.REPORTS_TABLE = 'reports'
  process.env.PULSE_CHECKS_TABLE = 'pulseChecks'
  process.env.DATA_BUCKET = 'pulse-data-bucket'
  process.env.CORS_ALLOWED_ORIGINS = 'https://pulse.urgd.dev'
})

describe('createTenant example seeding unit tests', () => {
  it('seeds example data successfully during tenant creation', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-createTenant/index.mjs')

    mockDynamoSend.mockResolvedValue({})
    mockS3Send.mockResolvedValue({})

    const event = {
      triggerSource: 'PostConfirmation_ConfirmSignUp',
      userName: 'test-tenant-id',
    }

    const result = await handler(event)

    // Cognito trigger returns the event
    expect(result).toBe(event)

    // Should have written: tenant + item + session + transcript batch + report + pulseCheck = 6 DynamoDB calls
    // Plus S3 put for document
    expect(mockDynamoSend.mock.calls.length).toBeGreaterThanOrEqual(6)
    expect(mockS3Send).toHaveBeenCalledTimes(1)

    // Verify item has isExample: true
    const putItemCalls = mockDynamoSend.mock.calls.filter(c => c[0]._type === 'PutItem')
    const itemCall = putItemCalls.find(c => c[0].input.TableName === process.env.ITEMS_TABLE)
    expect(itemCall).toBeDefined()
    expect(itemCall[0].input.Item.isExample.BOOL).toBe(true)
  })

  it('tenant creation succeeds even when seeding fails', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-createTenant/index.mjs')

    let callCount = 0
    mockDynamoSend.mockImplementation((cmd) => {
      callCount++
      // First call (tenant PutItem) succeeds, subsequent calls (seeding) fail
      if (callCount === 1) return Promise.resolve({})
      return Promise.reject(new Error('DynamoDB seeding error'))
    })

    const event = {
      triggerSource: 'PostConfirmation_ConfirmSignUp',
      userName: 'test-tenant-id-2',
    }

    // Should not throw — seeding failure is caught
    const result = await handler(event)
    expect(result).toBe(event)
  })
})
