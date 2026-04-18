// Property-based test for revision-ready email content
// Verifies that buildRevisionReadyEmail produces correct subject and body content
// for any item name and item ID combination.
//
// **Validates: Requirements 3.2, 3.3**

import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'

// Stub environment variables before importing index.mjs
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('ALERTS_TOPIC_ARN', 'arn:aws:sns:us-west-2:123456789:alerts')
vi.stubEnv('APP_URL', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

// Mock AWS SDK clients so importing index.mjs doesn't fail
vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send() { return Promise.resolve({}) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand }
})

vi.mock('@aws-sdk/client-ses', () => {
  class SESClient { send() { return Promise.resolve({}) } }
  class SendEmailCommand { constructor(input) { this.input = input } }
  return { SESClient, SendEmailCommand }
})

vi.mock('@aws-sdk/client-sns', () => {
  class SNSClient { send() { return Promise.resolve({}) } }
  class PublishCommand { constructor(input) { this.input = input } }
  return { SNSClient, PublishCommand }
})

const { buildRevisionReadyEmail } = await import('./index.mjs')

// Generator for non-empty item name strings (printable, at least 1 char)
const itemNameArb = fc.string({ minLength: 1, maxLength: 100 })
  .filter(s => s.trim().length > 0)

// Generator for valid UUIDs
const uuidArb = fc.uuid()

// Fixed app URL for testing
const APP_URL = 'https://pulse.urgdstudios.com'

/**
 * Property 3: Revision-ready email contains item name and correct URL
 *
 * For any item name string and any valid itemId, the email content produced by
 * buildRevisionReadyEmail(itemName, itemId, appUrl) satisfies:
 *   (a) the subject line contains the item name
 *   (b) both the HTML body and plain-text body contain /admin/items/{itemId}/revisions
 *
 * **Validates: Requirements 3.2, 3.3**
 */
describe('Feature: async-revision-generation, Property 3: Email contains item name and URL', () => {
  it('subject contains the item name', () => {
    // **Validates: Requirements 3.2**
    fc.assert(
      fc.property(
        itemNameArb,
        uuidArb,
        (itemName, itemId) => {
          const { subject } = buildRevisionReadyEmail(itemName, itemId, APP_URL)
          expect(subject).toContain(itemName)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('HTML body contains the correct revisions URL path', () => {
    // **Validates: Requirements 3.3**
    fc.assert(
      fc.property(
        itemNameArb,
        uuidArb,
        (itemName, itemId) => {
          const { htmlBody } = buildRevisionReadyEmail(itemName, itemId, APP_URL)
          const expectedPath = `/admin/items/${itemId}/revisions`
          expect(htmlBody).toContain(expectedPath)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('plain-text body contains the correct revisions URL path', () => {
    // **Validates: Requirements 3.3**
    fc.assert(
      fc.property(
        itemNameArb,
        uuidArb,
        (itemName, itemId) => {
          const { textBody } = buildRevisionReadyEmail(itemName, itemId, APP_URL)
          const expectedPath = `/admin/items/${itemId}/revisions`
          expect(textBody).toContain(expectedPath)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('both HTML and text bodies contain the full revisions URL with appUrl prefix', () => {
    // **Validates: Requirements 3.3**
    fc.assert(
      fc.property(
        itemNameArb,
        uuidArb,
        (itemName, itemId) => {
          const { htmlBody, textBody } = buildRevisionReadyEmail(itemName, itemId, APP_URL)
          const expectedUrl = `${APP_URL}/admin/items/${itemId}/revisions`
          expect(htmlBody).toContain(expectedUrl)
          expect(textBody).toContain(expectedUrl)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('subject and bodies are non-empty strings', () => {
    // **Validates: Requirements 3.2, 3.3**
    fc.assert(
      fc.property(
        itemNameArb,
        uuidArb,
        (itemName, itemId) => {
          const { subject, htmlBody, textBody } = buildRevisionReadyEmail(itemName, itemId, APP_URL)
          expect(typeof subject).toBe('string')
          expect(subject.length).toBeGreaterThan(0)
          expect(typeof htmlBody).toBe('string')
          expect(htmlBody.length).toBeGreaterThan(0)
          expect(typeof textBody).toBe('string')
          expect(textBody.length).toBeGreaterThan(0)
        },
      ),
      { numRuns: 100 },
    )
  })
})
