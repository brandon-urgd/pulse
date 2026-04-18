// Feature: pulse, Property 4: Concurrency Budget Property
// Validates: Requirements 1.12

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadCfnTemplate } from './cfn-yaml.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatePath = join(__dirname, '..', 'pulse-stack.yaml');
const template = loadCfnTemplate(readFileSync(templatePath, 'utf8'));

// AWS default account-level concurrency limit
const ACCOUNT_CONCURRENCY_LIMIT = 1000;
const MAX_RESERVED_BUDGET = ACCOUNT_CONCURRENCY_LIMIT * 0.6; // 600 — prod tiered total is 581 as of Spec 2 S6

/**
 * Resolve a CloudFormation Mappings lookup for a given environment.
 * Handles: { 'Fn::FindInMap': ['Concurrency', { Ref: 'Environment' }, key] }
 */
function resolveMappingValue(value, env, mappings) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'object' && 'Fn::FindInMap' in value) {
    const [mapName, keyRef, subKey] = value['Fn::FindInMap'];
    const resolvedKey = typeof keyRef === 'object' && 'Ref' in keyRef
      ? (keyRef.Ref === 'Environment' ? env : keyRef.Ref)
      : keyRef;
    return mappings?.[mapName]?.[resolvedKey]?.[subKey];
  }

  return value;
}

/**
 * Extract all Lambda functions from the template Resources section.
 */
function getLambdaFunctions(template) {
  const resources = template.Resources || {};
  return Object.entries(resources)
    .filter(([, resource]) => resource.Type === 'AWS::Lambda::Function')
    .map(([logicalId, resource]) => ({ logicalId, resource }));
}

/**
 * Resolve ReservedConcurrentExecutions for a Lambda function given an environment.
 */
function resolveReservedConcurrency(resource, env, mappings) {
  const rce = resource.Properties?.ReservedConcurrentExecutions;
  if (rce === undefined || rce === null) return undefined;
  if (typeof rce === 'number') return rce;
  return resolveMappingValue(rce, env, mappings);
}

describe('Property 4: Concurrency Budget Property', () => {
  it('sum of ReservedConcurrentExecutions does not exceed 50% of account limit (500) for any environment', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('dev', 'staging', 'prod'),
        (env) => {
          const lambdas = getLambdaFunctions(template);
          const mappings = template.Mappings || {};

          const concurrencyValues = lambdas.map(({ logicalId, resource }) => {
            const value = resolveReservedConcurrency(resource, env, mappings);
            return { logicalId, value };
          });

          const total = concurrencyValues.reduce((sum, { value }) => sum + (value || 0), 0);

          expect(total).toBeLessThanOrEqual(MAX_RESERVED_BUDGET);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('every Lambda function has ReservedConcurrentExecutions set for any environment', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('dev', 'staging', 'prod'),
        (env) => {
          const lambdas = getLambdaFunctions(template);
          const mappings = template.Mappings || {};

          for (const { logicalId, resource } of lambdas) {
            const value = resolveReservedConcurrency(resource, env, mappings);
            expect(
              value,
              `Lambda ${logicalId} is missing ReservedConcurrentExecutions for env=${env}`
            ).toBeDefined();
            expect(
              typeof value,
              `Lambda ${logicalId} ReservedConcurrentExecutions must be a number for env=${env}`
            ).toBe('number');
            expect(value).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('prod concurrency values match the tiered design (health:5, cognitoAuth:25, sessionAuth:15)', () => {
    fc.assert(
      fc.property(
        fc.constant('prod'),
        (env) => {
          const lambdas = getLambdaFunctions(template);
          const mappings = template.Mappings || {};

          const byLogicalId = Object.fromEntries(
            lambdas.map(({ logicalId, resource }) => [
              logicalId,
              resolveReservedConcurrency(resource, env, mappings),
            ])
          );

          expect(byLogicalId['PulseHealthFunction']).toBe(5);
          expect(byLogicalId['PulseBedrockHealthFunction']).toBe(5);
          expect(byLogicalId['PulseCognitoAuthFunction']).toBe(25);
          expect(byLogicalId['PulseSessionAuthFunction']).toBe(15);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('dev concurrency values are all 3 (flat)', () => {
    fc.assert(
      fc.property(
        fc.constant('dev'),
        (env) => {
          const lambdas = getLambdaFunctions(template);
          const mappings = template.Mappings || {};

          for (const { logicalId, resource } of lambdas) {
            const value = resolveReservedConcurrency(resource, env, mappings);
            expect(
              value,
              `Lambda ${logicalId} should have concurrency=3 in dev`
            ).toBe(3);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // PrimeCacheWorker uses concurrency=3 in staging (background worker, lower traffic)
  const STAGING_EXCEPTIONS = {
    PulsePrimeCacheWorkerFunction: 3,
  };

  it('staging concurrency values are all 5 (flat) except known exceptions', () => {
    fc.assert(
      fc.property(
        fc.constant('staging'),
        (env) => {
          const lambdas = getLambdaFunctions(template);
          const mappings = template.Mappings || {};

          for (const { logicalId, resource } of lambdas) {
            const value = resolveReservedConcurrency(resource, env, mappings);
            const expected = STAGING_EXCEPTIONS[logicalId] ?? 5;
            expect(
              value,
              `Lambda ${logicalId} should have concurrency=${expected} in staging`
            ).toBe(expected);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
