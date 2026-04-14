// Property tests for Session Start Streaming Fix — System Prompt Optimization
// Tasks 1 (exploration) and 2 (preservation)
// Validates that buildSystemPrompt excludes document text when nativeDocumentAvailable is true

import { describe, it, expect, vi } from 'vitest'
import fc from 'fast-check'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

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

const { buildSystemPrompt } = await import('../../lambdas/shared/buildSystemPrompt.mjs')

// ═══════════════════════════════════════════════════════════════════════════
// Task 1 — Bug Condition Exploration: System prompt excludes document text
// when nativeDocumentAvailable is true
// ═══════════════════════════════════════════════════════════════════════════

describe('Bug Condition: System prompt excludes redundant document text', () => {
  it('when nativeDocumentAvailable is true, output does NOT contain itemContent', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 50, maxLength: 500 }),  // itemContent (document text)
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),  // itemName
        fc.integer({ min: 1, max: 10 }),  // totalSections
        fc.integer({ min: 5, max: 60 }),  // timeLimitMinutes
        (itemContent, itemName, totalSections, timeLimitMinutes) => {
          const result = buildSystemPrompt({
            itemName,
            itemDescription: 'Review this document',
            itemContent,
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
            nativeDocumentAvailable: true,
          })

          // The document text should NOT be in the system prompt
          expect(result).not.toContain(itemContent)
          // But behavioral instructions should still be present
          expect(result).toContain('BEHAVIORAL GUARDRAILS')
          expect(result).toContain(itemName)
          // Should contain the native document reference instead
          expect(result).toContain('native file attachment')
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Task 2 — Preservation: Existing behavior unchanged for non-bug inputs
// ═══════════════════════════════════════════════════════════════════════════

describe('Preservation: System prompt behavior unchanged for non-bug inputs', () => {
  it('when nativeDocumentAvailable is false, output CONTAINS itemContent', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 50, maxLength: 500 }),
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
        (itemContent, itemName) => {
          const result = buildSystemPrompt({
            itemName,
            itemDescription: '',
            itemContent,
            itemType: 'document',
            totalSections: 3,
            currentSection: 1,
            closingState: 'exploring',
            windingDown: undefined,
            message: '__session_start__',
            isSpecial: true,
            frozenSnapshot: null,
            coverageMap: null,
            imageBase64: null,
            isSelfReview: false,
            timeLimitMinutes: 30,
            nativeDocumentAvailable: false,
          })

          expect(result).toContain(itemContent)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('when nativeDocumentAvailable is undefined (backward compat), output CONTAINS itemContent', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 50, maxLength: 500 }),
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
        (itemContent, itemName) => {
          const result = buildSystemPrompt({
            itemName,
            itemDescription: '',
            itemContent,
            itemType: 'document',
            totalSections: 3,
            currentSection: 1,
            closingState: 'exploring',
            windingDown: undefined,
            message: '__session_start__',
            isSpecial: true,
            frozenSnapshot: null,
            coverageMap: null,
            imageBase64: null,
            isSelfReview: false,
            timeLimitMinutes: 30,
            // nativeDocumentAvailable not provided — backward compat
          })

          expect(result).toContain(itemContent)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('image sessions never contain itemContent regardless of nativeDocumentAvailable', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 50, maxLength: 500 }),
        fc.boolean(),  // nativeDocumentAvailable (should not matter for images)
        (itemContent, nativeDocumentAvailable) => {
          const result = buildSystemPrompt({
            itemName: 'Test Image',
            itemDescription: '',
            itemContent,
            itemType: 'image',
            totalSections: 1,
            currentSection: 1,
            closingState: 'exploring',
            windingDown: undefined,
            message: '__session_start__',
            isSpecial: true,
            frozenSnapshot: null,
            coverageMap: null,
            imageBase64: null,
            isSelfReview: false,
            timeLimitMinutes: 30,
            nativeDocumentAvailable,
          })

          expect(result).not.toContain(itemContent)
          expect(result).toContain('image feedback session')
        },
      ),
      { numRuns: 100 },
    )
  })
})
