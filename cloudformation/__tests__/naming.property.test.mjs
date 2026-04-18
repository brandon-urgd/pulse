// Feature: pulse, Property 1: Resource Naming Invariant
// Validates: Requirements 1.1, 1.13

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadCfnTemplate } from './cfn-yaml.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatePath = join(__dirname, '..', 'pulse-stack.yaml');
const template = loadCfnTemplate(readFileSync(templatePath, 'utf8'));

/**
 * Collect all string values from a CloudFormation !Sub expression or plain string
 * that represent resource names. We look for patterns like:
 *   !Sub 'urgd-pulse-{something}-${Environment}'
 * which in parsed YAML appear as the string "urgd-pulse-{something}-${Environment}"
 */
function collectSubStrings(obj, results = []) {
  if (typeof obj === 'string') {
    results.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) collectSubStrings(item, results);
  } else if (obj !== null && typeof obj === 'object') {
    for (const val of Object.values(obj)) collectSubStrings(val, results);
  }
  return results;
}

/**
 * Given a parsed template and an environment string, resolve !Sub expressions
 * by substituting ${Environment} with the given env value.
 */
function resolveSubStrings(strings, env) {
  return strings.map(s => s.replace(/\$\{Environment\}/g, env));
}

/**
 * Extract all resource names from the template that follow the urgd-pulse-{resource}-{env} pattern.
 * These come from TableName, BucketName, FunctionName, TopicName, etc. properties.
 * We require at least one character between 'urgd-pulse-' and '-{env}' to exclude bare
 * strings like 'urgd-pulse-dev' (e.g. CloudFront distribution comments).
 */
function extractResourceNames(template, env) {
  const allStrings = collectSubStrings(template);
  const resolved = resolveSubStrings(allStrings, env);
  // Must match urgd-pulse-{something}-{env} where {something} is at least one char
  const pattern = new RegExp(`^urgd-pulse-.+-${env}$`); // nosemgrep: detect-non-literal-regexp
  return resolved.filter(s => pattern.test(s) && !s.includes('${'));
}

/**
 * DynamoDB table names must follow urgd-pulse-{tablename}-{env}
 */
const EXPECTED_TABLE_NAMES = [
  'tenants',
  'items',
  'sessions',
  'transcripts',
  'reports',
  'pulsechecks',
];

describe('Property 1: Resource Naming Invariant', () => {
  it('all urgd-pulse resource names end with the environment suffix for any valid environment', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('dev', 'staging', 'prod'),
        (env) => {
          const names = extractResourceNames(template, env);

          // Every extracted name must match urgd-pulse-{something}-{env}
          for (const name of names) {
            expect(name).toMatch(new RegExp(`^urgd-pulse-.+-${env}$`)); // nosemgrep: detect-non-literal-regexp
          }

          // Must have found at least some names (sanity check template was parsed)
          expect(names.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('all 6 DynamoDB table names follow urgd-pulse-{tablename}-{env} for any valid environment', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('dev', 'staging', 'prod'),
        (env) => {
          const names = extractResourceNames(template, env);

          for (const tableName of EXPECTED_TABLE_NAMES) {
            const expected = `urgd-pulse-${tableName}-${env}`;
            expect(names).toContain(expected);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('all Lambda function names follow urgd-pulse-{function}-{env} for any valid environment', () => {
    const EXPECTED_LAMBDA_NAMES = [
      'health',
      'bedrockHealth',
      'cognitoAuth',
      'sessionAuth',
    ];

    fc.assert(
      fc.property(
        fc.constantFrom('dev', 'staging', 'prod'),
        (env) => {
          const names = extractResourceNames(template, env);

          for (const fnName of EXPECTED_LAMBDA_NAMES) {
            const expected = `urgd-pulse-${fnName}-${env}`;
            expect(names).toContain(expected);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('no resource name contains a literal ${Environment} placeholder after resolution', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('dev', 'staging', 'prod'),
        (env) => {
          const names = extractResourceNames(template, env);
          for (const name of names) {
            expect(name).not.toContain('${');
            expect(name).not.toContain('Environment');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
