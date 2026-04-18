// Property-based test for prompt selection
// Verifies selectPrompt always returns the annotated change list prompt
// regardless of document type.

import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'

// Stub environment variables before importing index.mjs
vi.stubEnv('PULSE_CHECKS_TABLE', 'urgd-pulse-pulsechecks-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('REVISIONS_TABLE', 'urgd-pulse-revisions-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')
vi.stubEnv('AWS_REGION', 'us-west-2')
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('SEND_REVISION_READY_FUNCTION_NAME', 'urgd-pulse-sendRevisionReady-dev')

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send() { return Promise.resolve({}) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, UpdateItemCommand }
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
  return { BedrockRuntimeClient, ConverseCommand }
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

const { selectPrompt } = await import('./index.mjs')

const ANNOTATED_MARKER = 'structured change list'

describe('Property 4: selectPrompt always returns annotated change list prompt', () => {
  const anyExtArb = fc.constantFrom('pdf', 'docx', 'md', 'txt', 'jpg', 'png', 'html')
  const filenameBaseArb = fc.string({ minLength: 1, maxLength: 30 })
    .filter(s => s.length > 0 && /^[a-zA-Z0-9_-]+$/.test(s))

  it('returns annotated change list prompt for any file extension', () => {
    fc.assert(
      fc.property(filenameBaseArb, anyExtArb, (base, ext) => {
        const prompt = selectPrompt(`pulse/tenant/items/item/${base}.${ext}`)
        expect(prompt).toContain(ANNOTATED_MARKER)
      }),
      { numRuns: 200 },
    )
  })

  it('returns annotated change list prompt for null/undefined documentKey', () => {
    expect(selectPrompt(null)).toContain(ANNOTATED_MARKER)
    expect(selectPrompt(undefined)).toContain(ANNOTATED_MARKER)
  })
})
