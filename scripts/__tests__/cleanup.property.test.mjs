/**
 * Property-based tests for compute-cleanup.mjs
 *
 * Uses fast-check to verify correctness properties of the artifact
 * retention logic across a wide range of generated inputs.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeDeletionPlan, extractProtectedVersions, buildDeploymentMetadata } from '../compute-cleanup.mjs';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Arbitrary non-empty version string (e.g. "1.2.3", "abc-20250101") */
const arbVersion = () =>
  fc.stringMatching(/^[a-z0-9][a-z0-9.\-]{0,19}$/);

/** Arbitrary ISO-8601-ish timestamp for sorting */
const arbTimestamp = () =>
  fc.integer({
    min: new Date('2024-01-01T00:00:00Z').getTime(),
    max: new Date('2026-12-31T23:59:59Z').getTime(),
  }).map((ms) => new Date(ms).toISOString());

/** Arbitrary ArtifactEntry */
const arbArtifact = () =>
  fc.record({
    key: fc.stringMatching(/^s3:\/\/bucket\/[a-z0-9\-\/]{1,40}$/),
    version: arbVersion(),
    timestamp: arbTimestamp(),
  });

/** Arbitrary list of artifacts (0–30 items) */
const arbArtifactList = () => fc.array(arbArtifact(), { minLength: 0, maxLength: 30 });

/** Arbitrary set of protected versions (as an array, converted to Set in test) */
const arbProtectedVersions = () =>
  fc.uniqueArray(arbVersion(), { minLength: 0, maxLength: 5 });

/** Arbitrary retention count */
const arbRetainCount = () => fc.integer({ min: 0, max: 20 });

// ---------------------------------------------------------------------------
// Property 1: Protected version exclusion
// ---------------------------------------------------------------------------

describe('cleanup property tests', () => {
  /**
   * **Validates: Requirements 1.3, 1.4**
   *
   * Property 1: Protected version exclusion — for any artifact list and
   * protected version set, no protected version appears in `toDelete`.
   */
  it('Property 1: no protected version appears in toDelete', () => {
    fc.assert(
      fc.property(
        arbArtifactList(),
        arbProtectedVersions(),
        arbRetainCount(),
        (artifacts, protectedArr, retainCount) => {
          const protectedVersions = new Set(protectedArr);
          const plan = computeDeletionPlan(artifacts, protectedVersions, retainCount);

          // Every artifact in toDelete must NOT have a protected version
          for (const artifact of plan.toDelete) {
            expect(protectedVersions.has(artifact.version)).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 1.5**
   *
   * Property 2: Retention count correctness — for any list of unprotected
   * artifact versions and any retention count N ≥ 0, the deletion plan SHALL
   * retain exactly `min(N, total_unprotected)` most recent versions (by
   * timestamp) and mark all others for deletion.
   */
  it('Property 2: retention count correctness for unprotected artifacts', () => {
    fc.assert(
      fc.property(
        arbArtifactList(),
        arbRetainCount(),
        (artifacts, retainCount) => {
          // Use an empty protected set so every artifact is unprotected
          const protectedVersions = new Set();
          const plan = computeDeletionPlan(artifacts, protectedVersions, retainCount);

          const totalUnprotected = artifacts.length;
          const expectedRetained = Math.min(retainCount, totalUnprotected);
          const expectedDeleted = totalUnprotected - expectedRetained;

          // Correct number of retained unprotected artifacts
          expect(plan.toRetain.length).toBe(expectedRetained);

          // Correct number of deleted artifacts
          expect(plan.toDelete.length).toBe(expectedDeleted);

          // Retained + deleted accounts for every input artifact
          expect(plan.toRetain.length + plan.toDelete.length).toBe(totalUnprotected);

          // The retained artifacts should be the most recent by timestamp
          if (expectedRetained > 0 && expectedDeleted > 0) {
            const sortedDesc = [...artifacts].sort((a, b) => {
              if (a.timestamp > b.timestamp) return -1;
              if (a.timestamp < b.timestamp) return 1;
              return 0;
            });

            const expectedRetainedKeys = new Set(
              sortedDesc.slice(0, expectedRetained).map((a) => a.key),
            );

            for (const retained of plan.toRetain) {
              expect(expectedRetainedKeys.has(retained.key)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 1.6**
   *
   * Property 3: Metadata field completeness — for any valid deployment
   * parameters (version string, commit SHA, environment name, stack name,
   * deployer identity, timestamp), the `buildDeploymentMetadata` function
   * SHALL produce a JSON object containing all six required fields
   * (`version`, `commit_sha`, `environment`, `stack_name`, `deployed_by`,
   * `build_time`) with non-empty string values.
   */
  it('Property 3: output JSON contains all six required non-empty fields for any valid parameters', () => {
    /** Arbitrary non-empty trimmed string (no leading/trailing whitespace only) */
    const arbNonEmptyString = () =>
      fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._\-/ ]{0,29}[a-zA-Z0-9]$/).filter((s) => s.trim().length > 0);

    /** Arbitrary ISO-8601 timestamp string */
    const arbBuildTime = () =>
      fc.integer({
        min: new Date('2024-01-01T00:00:00Z').getTime(),
        max: new Date('2026-12-31T23:59:59Z').getTime(),
      }).map((ms) => new Date(ms).toISOString());

    const REQUIRED_FIELDS = ['version', 'commit_sha', 'environment', 'stack_name', 'deployed_by', 'build_time'];

    fc.assert(
      fc.property(
        arbNonEmptyString(),  // version
        arbNonEmptyString(),  // commit_sha
        arbNonEmptyString(),  // environment
        arbNonEmptyString(),  // stack_name
        arbNonEmptyString(),  // deployed_by
        arbBuildTime(),       // build_time
        (version, commit_sha, environment, stack_name, deployed_by, build_time) => {
          const metadata = buildDeploymentMetadata({
            version,
            commit_sha,
            environment,
            stack_name,
            deployed_by,
            build_time,
          });

          // All six required fields must be present and non-empty strings
          for (const field of REQUIRED_FIELDS) {
            expect(metadata).toHaveProperty(field);
            expect(typeof metadata[field]).toBe('string');
            expect(metadata[field].trim().length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // ---------------------------------------------------------------------------
  // Property 4: Metadata extraction resilience
  // ---------------------------------------------------------------------------

  /**
   * **Validates: Requirements 1.1, 1.10**
   *
   * Property 4: Metadata extraction resilience — for any combination of
   * valid, missing (null), or malformed per-environment metadata inputs,
   * the `extractProtectedVersions` function SHALL:
   *  - Return a set containing exactly the versions from valid inputs
   *  - Not throw
   *  - Produce a warning for each invalid/missing input
   */
  it('Property 4: metadata extraction resilience for any valid/missing/malformed combination', () => {
    const ENV_NAMES = ['dev', 'staging', 'prod'];

    /**
     * Arbitrary per-environment metadata entry — one of:
     *  - "valid"     → full DeploymentMetadata with a real version string
     *  - "null"      → null (metadata missing entirely)
     *  - "malformed" → object present but version field is missing, empty, or non-string
     */
    const arbMetadataEntry = () =>
      fc.oneof(
        // Valid metadata with a proper version
        arbVersion().map((v) => ({
          kind: 'valid',
          value: {
            version: v,
            commit_sha: 'abc1234',
            environment: 'dev',
            stack_name: 'stack',
            deployed_by: 'ci',
            build_time: '2025-01-01T00:00:00Z',
          },
        })),
        // Missing metadata (null)
        fc.constant({ kind: 'null', value: null }),
        // Malformed — version is empty string
        fc.constant({
          kind: 'malformed',
          value: { version: '', commit_sha: 'x', environment: 'dev', stack_name: 's', deployed_by: 'ci', build_time: '2025-01-01T00:00:00Z' },
        }),
        // Malformed — version is a number instead of string
        fc.constant({
          kind: 'malformed',
          value: { version: 42, commit_sha: 'x', environment: 'dev', stack_name: 's', deployed_by: 'ci', build_time: '2025-01-01T00:00:00Z' },
        }),
        // Malformed — version field missing entirely
        fc.constant({
          kind: 'malformed',
          value: { commit_sha: 'x', environment: 'dev', stack_name: 's', deployed_by: 'ci', build_time: '2025-01-01T00:00:00Z' },
        }),
        // Malformed — version is whitespace only
        fc.constant({
          kind: 'malformed',
          value: { version: '   ', commit_sha: 'x', environment: 'dev', stack_name: 's', deployed_by: 'ci', build_time: '2025-01-01T00:00:00Z' },
        }),
      );

    fc.assert(
      fc.property(
        arbMetadataEntry(),
        arbMetadataEntry(),
        arbMetadataEntry(),
        (devEntry, stagingEntry, prodEntry) => {
          const entries = [devEntry, stagingEntry, prodEntry];

          // Build the metadataByEnv object
          const metadataByEnv = {};
          ENV_NAMES.forEach((env, i) => {
            metadataByEnv[env] = entries[i].value;
          });

          // Must never throw
          let result;
          expect(() => {
            result = extractProtectedVersions(metadataByEnv);
          }).not.toThrow();

          // Compute expected valid versions
          const expectedVersions = new Set();
          let expectedWarningCount = 0;

          for (let i = 0; i < ENV_NAMES.length; i++) {
            if (entries[i].kind === 'valid') {
              expectedVersions.add(entries[i].value.version);
            } else {
              expectedWarningCount++;
            }
          }

          // protectedVersions should contain exactly the valid versions
          expect(result.protectedVersions).toBeInstanceOf(Set);
          expect(result.protectedVersions.size).toBe(expectedVersions.size);
          for (const v of expectedVersions) {
            expect(result.protectedVersions.has(v)).toBe(true);
          }

          // One warning per invalid/missing entry
          expect(result.warnings.length).toBe(expectedWarningCount);
        },
      ),
      { numRuns: 200 },
    );
  });
});
