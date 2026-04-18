// Property-based test for prompt selection based on document extension
// Uses fast-check with vitest to verify selectPrompt returns the correct prompt
// based on the document key's file extension.
//
// **Validates: Requirements 4.1, 4.4**

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

// Mock AWS SDK clients so importing index.mjs doesn't fail
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

// Marker strings to detect which prompt was returned
const ANNOTATED_MARKER = 'structured change list'
const REWRITE_MARKER = 'revised document text'

// Generator for random filename bases (alphanumeric, no dots)
const filenameBaseArb = fc.string({ minLength: 1, maxLength: 30 })
  .filter(s => s.length > 0 && /^[a-zA-Z0-9_-]+$/.test(s))

// Generator for optional S3 path prefix
const s3PrefixArb = fc.constantFrom(
  '',
  'pulse/tenant-123/items/item-456/',
  'documents/',
  'uploads/2026/',
)

/**
 * Property 4: Prompt selection based on document extension
 *
 * For any documentKey string, selectPrompt returns the annotated change list prompt
 * iff the documentKey ends in .pdf or .docx (case-insensitive). For .md, .txt, .jpg,
 * null, or undefined, it returns the full-document rewrite prompt.
 *
 * **Validates: Requirements 4.1, 4.4**
 */
describe('Feature: async-revision-generation, Property 4: Prompt selection by extension', () => {
  // Extensions that should trigger the annotated change list prompt
  const annotatedExtensions = ['pdf', 'docx']

  // Case variations for annotated extensions
  const annotatedExtArb = fc.constantFrom(...annotatedExtensions).chain(ext =>
    fc.constantFrom(
      ext.toLowerCase(),
      ext.toUpperCase(),
      ext.charAt(0).toUpperCase() + ext.slice(1),
      ext.split('').map((c, i) => i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()).join(''),
    ),
  )

  // Extensions that should trigger the full rewrite prompt
  const rewriteExtArb = fc.constantFrom('md', 'txt', 'jpg', 'png', 'html', 'csv', 'json', 'xml')

  it('returns annotated change list prompt for .pdf and .docx extensions (case-insensitive)', () => {
    fc.assert(
      fc.property(
        s3PrefixArb,
        filenameBaseArb,
        annotatedExtArb,
        (prefix, base, ext) => {
          const documentKey = `${prefix}${base}.${ext}`
          const prompt = selectPrompt(documentKey)
          expect(prompt).toContain(ANNOTATED_MARKER)
          expect(prompt).not.toContain(REWRITE_MARKER)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('returns full rewrite prompt for non-pdf/docx extensions', () => {
    fc.assert(
      fc.property(
        s3PrefixArb,
        filenameBaseArb,
        rewriteExtArb,
        (prefix, base, ext) => {
          const documentKey = `${prefix}${base}.${ext}`
          const prompt = selectPrompt(documentKey)
          expect(prompt).toContain(REWRITE_MARKER)
          expect(prompt).not.toContain(ANNOTATED_MARKER)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('returns full rewrite prompt for null and undefined documentKey', () => {
    const nullishArb = fc.constantFrom(null, undefined)

    fc.assert(
      fc.property(nullishArb, (documentKey) => {
        const prompt = selectPrompt(documentKey)
        expect(prompt).toContain(REWRITE_MARKER)
        expect(prompt).not.toContain(ANNOTATED_MARKER)
      }),
      { numRuns: 100 },
    )
  })

  it('prompt selection is purely determined by extension, not path prefix', () => {
    const anyPrefixArb = fc.string({ minLength: 0, maxLength: 50 }).map(s =>
      s.replace(/\./g, '/') + '/',
    )

    fc.assert(
      fc.property(
        anyPrefixArb,
        filenameBaseArb,
        fc.constantFrom('pdf', 'docx'),
        (prefix, base, ext) => {
          const documentKey = `${prefix}${base}.${ext}`
          const prompt = selectPrompt(documentKey)
          expect(prompt).toContain(ANNOTATED_MARKER)
        },
      ),
      { numRuns: 100 },
    )
  })
})
