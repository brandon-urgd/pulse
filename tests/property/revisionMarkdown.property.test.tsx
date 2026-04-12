// Property-based tests for revision markdown rendering safety
// Properties 7, 8 from the Pulse v1.1 Polish design

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'

/**
 * Helper: render a markdown string through ReactMarkdown and return the HTML output.
 * Uses the same component config as RevisionPane (img → alt text span).
 */
function renderMarkdown(input: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      components={{
        img: ({ alt }) => <span>{alt}</span>,
      }}
    >
      {input}
    </ReactMarkdown>,
  )
}

/**
 * Helper: decode HTML entities in a string.
 */
function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
}

/**
 * Helper: strip HTML tags from a string to get plain text content.
 */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

/**
 * Property 7: Markdown rendering is XSS-safe
 *
 * For any revision content string — including adversarial inputs containing
 * <script> tags, javascript: href values, or onerror event handlers — the
 * output rendered by ReactMarkdown does not contain unescaped <script> tags
 * or javascript: href attribute values.
 *
 * ReactMarkdown escapes raw HTML by default, so injected tags appear as
 * escaped text (e.g., &lt;script&gt;) rather than actual DOM elements.
 * The property verifies that no actual <script> elements or executable
 * javascript: hrefs exist in the rendered HTML output.
 *
 * **Validates: Requirement 6.4**
 */
describe('Property 7: Markdown rendering is XSS-safe', () => {
  // Arbitrary for adversarial XSS payloads mixed with normal text
  const xssPayloads = fc.oneof(
    fc.constant('<script>alert(1)</script>'),
    fc.constant('<script src="evil.js"></script>'),
    fc.constant('<img src=x onerror=alert(1)>'),
    fc.constant('<a href="javascript:alert(1)">click</a>'),
    fc.constant('<div onmouseover="alert(1)">hover</div>'),
    fc.constant('<iframe src="javascript:alert(1)"></iframe>'),
    fc.constant('<svg onload=alert(1)>'),
    fc.constant('<body onload=alert(1)>'),
    fc.constant('<input onfocus=alert(1) autofocus>'),
    fc.constant('[click me](javascript:alert(1))'),
  )

  const adversarialInput = fc.tuple(fc.string(), xssPayloads, fc.string()).map(
    ([prefix, payload, suffix]) => `${prefix}${payload}${suffix}`,
  )

  it('output does not contain actual <script> elements or executable javascript: hrefs', () => {
    fc.assert(
      fc.property(adversarialInput, (input) => {
        const html = renderMarkdown(input)

        // Check for actual <script> tags in the HTML (not escaped ones like &lt;script&gt;)
        // A real <script> tag would appear as <script in the raw HTML output
        // Escaped ones appear as &lt;script which is safe
        const hasActualScriptTag = /<script[\s>]/i.test(html)
        expect(hasActualScriptTag).toBe(false)

        // Check for javascript: in actual href attributes (not in escaped text)
        // An actual dangerous href would be: href="javascript:..."
        // Escaped text like &quot;javascript:...&quot; is safe
        const hasJsHref = /href\s*=\s*["']?\s*javascript:/i.test(html)
        expect(hasJsHref).toBe(false)

        // Check for event handler attributes in actual HTML tags
        const hasEventHandler = /<[a-z][^>]*\s+on[a-z]+=\s*/i.test(html)
        expect(hasEventHandler).toBe(false)
      }),
      { numRuns: 100 },
    )
  })
})

/**
 * Property 8: Markdown text preservation
 *
 * For any valid markdown string, rendering it with ReactMarkdown and then
 * extracting the text content (stripping HTML tags and decoding entities)
 * produces a string that contains all non-markup characters from the
 * original input (round-trip text preservation).
 *
 * **Validates: Requirement 6.2**
 */
describe('Property 8: Markdown text preservation', () => {
  it('all non-markup characters from input are present in rendered output', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const html = renderMarkdown(input)
        const textContent = decodeHtmlEntities(stripHtml(html))

        // Extract non-markup characters from input:
        // Strip HTML-like tags and markdown syntax characters, keep plain text
        const plainChars = input
          .replace(/<[^>]*>/g, '')                    // strip HTML tags
          .replace(/[#*_`~\[\]()!|>\\{}\-+]/g, '')   // strip markdown syntax chars
          .replace(/\s+/g, ' ')                       // normalize whitespace
          .trim()

        // Each remaining plain character should appear in the output
        for (const char of plainChars) {
          if (char.trim() === '') continue // skip whitespace
          expect(textContent).toContain(char)
        }
      }),
      { numRuns: 100 },
    )
  })
})
