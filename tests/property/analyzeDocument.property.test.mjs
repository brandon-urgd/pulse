// Property-based tests for analyzeDocument wordCount round-trip and invalid-value handling
// Properties 1, 2 from the Pulse v1.1 Polish design

import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'anthropic.claude-3-haiku-20240307-v1:0')
vi.stubEnv('AWS_REGION', 'us-west-2')

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send() { return Promise.resolve({}) } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send() { return Promise.resolve({}) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send() { return Promise.resolve({}) } }
  class ConverseCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, ConverseCommand }
})

const { parseSectionMap, marshalSectionMap } = await import(
  '../../lambdas/urgd-pulse-analyzeDocument/index.mjs'
)

/**
 * Property 1: wordCount round-trip fidelity
 *
 * For any section entry where wordCount is a non-negative integer,
 * parsing the Bedrock response with parseSectionMap() and then marshalling
 * with marshalSectionMap() produces a DynamoDB attribute where wordCount.N
 * equals the original value as a string.
 *
 * **Validates: Requirements 1.2, 1.3**
 */
describe('Property 1: wordCount round-trip fidelity', () => {
  it('parseSectionMap → marshalSectionMap round-trips wordCount as DynamoDB N attribute', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        (wordCount) => {
          const bedrockJson = JSON.stringify({
            sections: [
              { id: 's1', title: 'Test Section', classification: 'substantive', wordCount },
            ],
          })

          const parsed = parseSectionMap(bedrockJson)
          expect(parsed.sections[0].wordCount).toBe(wordCount)

          const marshalled = marshalSectionMap(parsed)
          const dynamoEntry = marshalled.M.sections.L[0].M

          expect(dynamoEntry.wordCount).toBeDefined()
          expect(dynamoEntry.wordCount.N).toBe(String(wordCount))
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property 2: Invalid wordCount treated as absent
 *
 * For any section entry where wordCount is negative, null, NaN,
 * a non-integer float, or a non-numeric string, parseSectionMap()
 * produces a section entry with no wordCount field.
 *
 * **Validates: Requirements 1.4**
 */
describe('Property 2: Invalid wordCount treated as absent', () => {
  it('invalid wordCount values are omitted from parsed section entry', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(NaN),
          fc.integer({ max: -1 }),
          fc.float({ min: Math.fround(0.1), max: Math.fround(0.9) }),
          fc.string(),
        ),
        (invalidWordCount) => {
          const bedrockJson = JSON.stringify({
            sections: [
              { id: 's1', title: 'Test Section', classification: 'substantive', wordCount: invalidWordCount },
            ],
          })

          const parsed = parseSectionMap(bedrockJson)
          expect(parsed.sections[0]).not.toHaveProperty('wordCount')
        },
      ),
      { numRuns: 100 },
    )
  })
})
