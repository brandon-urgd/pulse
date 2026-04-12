// Property-based tests for chat Lambda time allocation
// Properties 3, 4, 4a from the Pulse v1.1 Polish design

import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'

// Stub env vars required by the chat Lambda at module load
vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'anthropic.claude-3-haiku-20240307-v1:0')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'http://localhost:3000')
vi.stubEnv('AWS_REGION', 'us-west-2')

// Mock all AWS SDK clients used by the chat Lambda
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
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send() { return Promise.resolve({}) } }
  class ConverseStreamCommand { constructor(input) { this.input = input } }
  class ConverseCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, ConverseStreamCommand, ConverseCommand }
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

const { computeTimeAllocations, DEPTH_MULTIPLIER } = await import(
  '../../lambdas/urgd-pulse-chat/index.mjs'
)

/**
 * Property 3: Time allocation sum conservation
 *
 * For any section map where all sections have wordCount > 0 and
 * timeLimitMinutes > 0, the sum of all per-section time allocations
 * equals timeLimitMinutes (within floating-point tolerance of ±0.001),
 * regardless of depth preferences.
 *
 * **Validates: Requirements 2.2, 2.5**
 */
describe('Property 3: Time allocation sum conservation', () => {
  it('sum of allocations equals timeLimitMinutes within ±0.001', () => {
    const depthArb = fc.constantFrom('deep', 'explore', 'skim')

    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 1, max: 120 }),
        fc.array(depthArb, { minLength: 0, maxLength: 20 }),
        (wordCounts, timeLimitMinutes, depths) => {
          const sections = wordCounts.map((wc, i) => ({
            id: `s${i}`,
            wordCount: wc,
          }))

          const depthPrefs = {}
          sections.forEach((s, i) => {
            if (i < depths.length) depthPrefs[s.id] = depths[i]
          })

          const allocations = computeTimeAllocations(sections, depthPrefs, timeLimitMinutes)
          const sum = allocations.reduce((a, b) => a + b, 0)

          expect(Math.abs(sum - timeLimitMinutes)).toBeLessThanOrEqual(0.001)
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property 4: Fallback time allocation — no invalid values
 *
 * For any section map where any section lacks wordCount or where all
 * wordCount values are 0, computeTimeAllocations() produces allocations
 * where every value is finite, non-negative, and not NaN. When all
 * effective weights are 0, every allocation equals timeLimitMinutes / N.
 *
 * **Validates: Requirements 2.3, 2.7**
 */
describe('Property 4: Fallback time allocation — no invalid values', () => {
  it('allocations with 0 or undefined wordCounts are finite, non-negative, not NaN', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(fc.constant(0), fc.constant(undefined)),
          { minLength: 1, maxLength: 20 },
        ),
        fc.integer({ min: 1, max: 120 }),
        (wordCounts, timeLimitMinutes) => {
          const sections = wordCounts.map((wc, i) => ({
            id: `s${i}`,
            wordCount: wc,
          }))

          const allocations = computeTimeAllocations(sections, {}, timeLimitMinutes)
          const N = sections.length
          const expected = timeLimitMinutes / N

          for (const alloc of allocations) {
            expect(Number.isFinite(alloc)).toBe(true)
            expect(alloc).toBeGreaterThanOrEqual(0)
            expect(Number.isNaN(alloc)).toBe(false)
          }

          // When all weights are 0 (no wordCounts, all default to explore=1.0),
          // the depth-only fallback produces equal allocations
          // But when wordCounts are all 0 or undefined, hasWordCounts is false,
          // so we fall back to depth-only. With all explore (1.0), weights are equal.
          // The last section absorbs remainder, so check within tolerance.
          for (const alloc of allocations) {
            expect(Math.abs(alloc - expected)).toBeLessThanOrEqual(0.001)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property 4a: Depth multiplier ordering
 *
 * For a fixed wordCount > 0, the time allocation with depth 'deep' is
 * greater than with depth 'explore', which is greater than with depth 'skim'.
 *
 * **Validates: Requirement 2.1**
 */
describe('Property 4a: Depth multiplier ordering', () => {
  it('deep allocation > explore allocation > skim allocation for same wordCount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 120 }),
        (wordCount, timeLimitMinutes) => {
          // Two sections: one target section and one fixed reference section.
          // The reference section keeps the total weight from being trivially equal.
          const targetId = 's0'
          const refId = 's1'
          const refWordCount = 500

          const baseSections = [
            { id: targetId, wordCount },
            { id: refId, wordCount: refWordCount },
          ]

          const deepAlloc = computeTimeAllocations(
            baseSections,
            { [targetId]: 'deep', [refId]: 'explore' },
            timeLimitMinutes,
          )[0]

          const exploreAlloc = computeTimeAllocations(
            baseSections,
            { [targetId]: 'explore', [refId]: 'explore' },
            timeLimitMinutes,
          )[0]

          const skimAlloc = computeTimeAllocations(
            baseSections,
            { [targetId]: 'skim', [refId]: 'explore' },
            timeLimitMinutes,
          )[0]

          expect(deepAlloc).toBeGreaterThan(exploreAlloc)
          expect(exploreAlloc).toBeGreaterThan(skimAlloc)
        },
      ),
      { numRuns: 100 },
    )
  })
})
