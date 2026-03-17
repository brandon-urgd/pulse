// Feature: pulse, Property 3: SPA Rewrite Property
// Validates: Requirements 1.7, 1.8, 1.9

import { describe, it, expect, beforeAll } from 'vitest';
import * as fc from 'fast-check';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadCfnTemplate } from './cfn-yaml.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatePath = join(__dirname, '..', 'pulse-stack.yaml');

/**
 * Extract the FunctionCode string from PulseSpaRewriteFunction in the CFN template.
 * The YAML block scalar (|) is parsed as a plain string by js-yaml.
 */
function extractSpaRewriteCode(template) {
  const fn = template.Resources.PulseSpaRewriteFunction;
  return fn.Properties.FunctionCode;
}

/**
 * Build a callable handler from the CloudFront Function code string.
 * CloudFront Functions use a restricted JS runtime — the code defines a
 * top-level `handler` function. We wrap it in a Function constructor so
 * we can call it directly in Node.js.
 */
function buildHandler(code) {
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${code}\nreturn handler;`);
  return factory();
}

let handler;

beforeAll(() => {
  const template = loadCfnTemplate(readFileSync(templatePath, 'utf8'));
  const code = extractSpaRewriteCode(template);
  handler = buildHandler(code);
});

/**
 * Helper: invoke the handler with a given URI and return the resulting URI.
 */
function rewrite(uri) {
  const event = { request: { uri } };
  const result = handler(event);
  return result.uri;
}

/**
 * Arbitrary: extensionless path segment (no dots, at least one char).
 * e.g. "dashboard", "items", "abc123"
 */
const extensionlessSegment = fc
  .stringMatching(/^[a-zA-Z0-9_-]+$/)
  .filter(s => s.length > 0 && !s.includes('.'));

/**
 * Arbitrary: extensionless path under /admin/ (e.g. /admin/items, /admin/login)
 */
const adminExtensionlessPath = fc
  .array(extensionlessSegment, { minLength: 1, maxLength: 4 })
  .map(segments => '/admin/' + segments.join('/'));

/**
 * Arbitrary: extensionless path under /s/ (e.g. /s/abc123, /s/abc/chat)
 */
const sessionExtensionlessPath = fc
  .array(extensionlessSegment, { minLength: 1, maxLength: 3 })
  .map(segments => '/s/' + segments.join('/'));

/**
 * Arbitrary: path with a file extension (contains a dot in the last segment).
 * e.g. /admin/main.js, /s/style.css, /assets/logo.png
 */
const extensions = fc.constantFrom('.js', '.css', '.png', '.svg', '.woff2', '.json', '.html', '.ico', '.map', '.txt');

const pathWithExtension = fc
  .tuple(
    fc.constantFrom('/admin/', '/s/', '/assets/', '/'),
    extensionlessSegment,
    extensions
  )
  .map(([prefix, name, ext]) => `${prefix}${name}${ext}`);

describe('Property 3: SPA Rewrite Property', () => {
  it('extensionless paths under /admin/* are rewritten to /admin/index.html', () => {
    fc.assert(
      fc.property(adminExtensionlessPath, (uri) => {
        expect(rewrite(uri)).toBe('/admin/index.html');
      }),
      { numRuns: 100 }
    );
  });

  it('extensionless paths under /s/* are rewritten to /s/index.html', () => {
    fc.assert(
      fc.property(sessionExtensionlessPath, (uri) => {
        expect(rewrite(uri)).toBe('/s/index.html');
      }),
      { numRuns: 100 }
    );
  });

  it('paths with file extensions pass through unchanged', () => {
    fc.assert(
      fc.property(pathWithExtension, (uri) => {
        expect(rewrite(uri)).toBe(uri);
      }),
      { numRuns: 100 }
    );
  });

  it('extensionless and has-extension cases are mutually exclusive', () => {
    // A URI either has a dot (extension case) or does not (rewrite case) — never both
    fc.assert(
      fc.property(
        fc.oneof(adminExtensionlessPath, sessionExtensionlessPath, pathWithExtension),
        (uri) => {
          const hasExtension = uri.includes('.');
          const isRewritten = rewrite(uri) !== uri;

          if (hasExtension) {
            // Extension paths must NOT be rewritten
            expect(isRewritten).toBe(false);
          } else if (uri.startsWith('/admin/') || uri.startsWith('/s/')) {
            // Extensionless SPA paths MUST be rewritten
            expect(isRewritten).toBe(true);
          }

          // The two outcomes are mutually exclusive: a path cannot be both
          // rewritten and pass-through at the same time
          expect(hasExtension && isRewritten).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});
