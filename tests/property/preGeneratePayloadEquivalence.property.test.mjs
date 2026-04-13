// Property-based tests for Session Fast Start — PreGenerate and Chat Lambda payload equivalence
// Task 14.6
// Uses fast-check for property-based testing

import { describe, it, expect, vi } from 'vitest'
import fc from 'fast-check'

// ── Environment variables (needed for module import) ──

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

// ── AWS SDK mocks (needed for Chat Lambda module import) ──

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send() { return Promise.resolve({}) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  class TransactWriteItemsCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand, TransactWriteItemsCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send() { return Promise.resolve({}) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  class PutObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand, PutObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send() { return Promise.resolve({}) } }
  class ConverseCommand { constructor(input) { this.input = input } }
  class ConverseStreamCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand }
})

vi.mock('@aws-sdk/client-cloudwatch', () => {
  class CloudWatchClient { send() { return Promise.resolve({}) } }
  class PutMetricDataCommand { constructor(input) { this.input = input } }
  return { CloudWatchClient, PutMetricDataCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send() { return Promise.resolve({}) } }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

// Import buildSystemPrompt from the shared module (same source used by both Lambdas)
const { buildSystemPrompt } = await import('../../lambdas/shared/buildSystemPrompt.mjs')

// ═══════════════════════════════════════════════════════════════════════════
// Property 6: PreGenerate and Chat Lambda payload equivalence
// **Validates: Requirements 9.1, 9.2, 9.4**
//
// Both PreGenerate and Chat Lambda call buildSystemPrompt with the same
// parameters for __session_start__. Verify that calling buildSystemPrompt
// with the same inputs always produces the same output.
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 6: PreGenerate and Chat Lambda payload equivalence', () => {
  it('buildSystemPrompt produces identical output for identical inputs', () => {
    // **Validates: Requirements 9.1, 9.2, 9.4**
    fc.assert(
      fc.property(
        // Generate arbitrary session parameters
        fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),  // itemName
        fc.string({ minLength: 0, maxLength: 200 }),  // itemDescription
        fc.integer({ min: 1, max: 20 }),               // totalSections
        fc.integer({ min: 5, max: 120 }),               // timeLimitMinutes
        fc.boolean(),                                    // isSelfReview
        (itemName, itemDescription, totalSections, timeLimitMinutes, isSelfReview) => {
          // Parameters that both PreGenerate and Chat Lambda use for __session_start__
          const params = {
            itemName,
            itemDescription,
            itemContent: '# Sample document content\n\nThis is a test document.',
            itemType: 'document',
            totalSections,
            currentSection: 1,
            closingState: 'exploring',
            windingDown: undefined,
            message: '__session_start__',
            isSpecial: true,
            frozenSnapshot: null,
            coverageMap: null,
            imageBase64: null,
            isSelfReview,
            timeLimitMinutes,
          }

          // Call buildSystemPrompt twice with the same params — simulating
          // PreGenerate Lambda and Chat Lambda calling the same function
          const preGenerateResult = buildSystemPrompt(params)
          const chatLambdaResult = buildSystemPrompt(params)

          // The outputs must be identical
          expect(preGenerateResult).toBe(chatLambdaResult)

          // Verify the output is a non-empty string
          expect(typeof preGenerateResult).toBe('string')
          expect(preGenerateResult.length).toBeGreaterThan(0)

          // Verify key content is present in the prompt
          expect(preGenerateResult).toContain(itemName)
          // __session_start__ triggers the opening instructions block
          expect(preGenerateResult).toContain('very start of the session')

          // Verify self-review vs third-party identity is correctly injected
          if (isSelfReview) {
            expect(preGenerateResult).toContain('self-review session')
          } else {
            expect(preGenerateResult).toContain('NOT the creator')
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('buildSystemPrompt is a pure function — no side effects between calls', () => {
    // **Validates: Requirements 9.1, 9.2, 9.4**
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),  // itemName
        fc.integer({ min: 1, max: 10 }),   // totalSections
        fc.integer({ min: 5, max: 60 }),   // timeLimitMinutes
        (itemName, totalSections, timeLimitMinutes) => {
          const params = {
            itemName,
            itemDescription: 'Focus on clarity',
            itemContent: '# Document',
            itemType: 'document',
            totalSections,
            currentSection: 1,
            closingState: 'exploring',
            windingDown: undefined,
            message: '__session_start__',
            isSpecial: true,
            frozenSnapshot: null,
            coverageMap: null,
            imageBase64: null,
            isSelfReview: false,
            timeLimitMinutes,
          }

          // Call multiple times — each call should produce the same result
          const result1 = buildSystemPrompt(params)
          const result2 = buildSystemPrompt(params)
          const result3 = buildSystemPrompt(params)

          expect(result1).toBe(result2)
          expect(result2).toBe(result3)
        },
      ),
      { numRuns: 100 },
    )
  })
})
