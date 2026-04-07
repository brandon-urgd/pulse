/**
 * Unit tests for compute-cleanup.mjs — edge cases
 *
 * Validates: Requirements 1.1, 1.5, 1.10
 */
import { describe, it, expect } from 'vitest';
import { extractProtectedVersions, computeDeletionPlan } from '../compute-cleanup.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ArtifactEntry */
const artifact = (version, timestamp, key) => ({
  key: key ?? `s3://bucket/lambda/${version}.zip`,
  version,
  timestamp,
});

// ---------------------------------------------------------------------------
// Edge case 1: All three metadata files missing
// ---------------------------------------------------------------------------

describe('all three metadata files missing', () => {
  it('returns empty protected set with three warnings', () => {
    const metadataByEnv = { dev: null, staging: null, prod: null };
    const result = extractProtectedVersions(metadataByEnv);

    expect(result.protectedVersions.size).toBe(0);
    expect(result.warnings).toHaveLength(3);
  });

  it('cleanup proceeds — all artifacts eligible for deletion based on retainCount', () => {
    const metadataByEnv = { dev: null, staging: null, prod: null };
    const { protectedVersions } = extractProtectedVersions(metadataByEnv);

    const artifacts = [
      artifact('1.0.0', '2025-01-01T00:00:00Z'),
      artifact('1.1.0', '2025-01-02T00:00:00Z'),
      artifact('1.2.0', '2025-01-03T00:00:00Z'),
    ];

    const plan = computeDeletionPlan(artifacts, protectedVersions, 1);

    // Only the most recent kept, two deleted
    expect(plan.toRetain).toHaveLength(1);
    expect(plan.toRetain[0].version).toBe('1.2.0');
    expect(plan.toDelete).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Edge case 2: Duplicate versions across environments
// ---------------------------------------------------------------------------

describe('duplicate versions across environments', () => {
  it('deduplicates — shared version appears once in protected set', () => {
    const shared = {
      version: '2.0.0',
      commit_sha: 'abc',
      environment: 'dev',
      stack_name: 'stack',
      deployed_by: 'ci',
      build_time: '2025-01-01T00:00:00Z',
    };

    const metadataByEnv = {
      dev: { ...shared, environment: 'dev' },
      staging: { ...shared, environment: 'staging' },
      prod: {
        version: '1.9.0',
        commit_sha: 'def',
        environment: 'prod',
        stack_name: 'stack',
        deployed_by: 'ci',
        build_time: '2025-01-01T00:00:00Z',
      },
    };

    const { protectedVersions, warnings } = extractProtectedVersions(metadataByEnv);

    // Two unique versions even though three environments
    expect(protectedVersions.size).toBe(2);
    expect(protectedVersions.has('2.0.0')).toBe(true);
    expect(protectedVersions.has('1.9.0')).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('shared version is still protected in deletion plan', () => {
    const protectedVersions = new Set(['2.0.0']);

    const artifacts = [
      artifact('2.0.0', '2025-01-03T00:00:00Z'),
      artifact('1.8.0', '2025-01-01T00:00:00Z'),
      artifact('1.9.0', '2025-01-02T00:00:00Z'),
    ];

    const plan = computeDeletionPlan(artifacts, protectedVersions, 0);

    // Protected version retained even with retainCount=0
    expect(plan.toRetain.some((a) => a.version === '2.0.0')).toBe(true);
    expect(plan.toDelete.every((a) => a.version !== '2.0.0')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge case 3: Zero retention count
// ---------------------------------------------------------------------------

describe('zero retention count', () => {
  it('deletes all unprotected artifacts', () => {
    const protectedVersions = new Set(['3.0.0']);

    const artifacts = [
      artifact('3.0.0', '2025-01-04T00:00:00Z'),
      artifact('2.0.0', '2025-01-03T00:00:00Z'),
      artifact('1.0.0', '2025-01-02T00:00:00Z'),
      artifact('0.9.0', '2025-01-01T00:00:00Z'),
    ];

    const plan = computeDeletionPlan(artifacts, protectedVersions, 0);

    // Only the protected version is retained
    expect(plan.toRetain).toHaveLength(1);
    expect(plan.toRetain[0].version).toBe('3.0.0');

    // All three unprotected versions deleted
    expect(plan.toDelete).toHaveLength(3);
    const deletedVersions = plan.toDelete.map((a) => a.version);
    expect(deletedVersions).toContain('2.0.0');
    expect(deletedVersions).toContain('1.0.0');
    expect(deletedVersions).toContain('0.9.0');
  });

  it('with no protected versions, deletes everything', () => {
    const artifacts = [
      artifact('1.0.0', '2025-01-01T00:00:00Z'),
      artifact('2.0.0', '2025-01-02T00:00:00Z'),
    ];

    const plan = computeDeletionPlan(artifacts, new Set(), 0);

    expect(plan.toRetain).toHaveLength(0);
    expect(plan.toDelete).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Edge case 4: More protected versions than total artifacts
// ---------------------------------------------------------------------------

describe('more protected versions than total artifacts', () => {
  it('retains all artifacts when all are protected', () => {
    const protectedVersions = new Set(['1.0.0', '2.0.0', '3.0.0', '4.0.0', '5.0.0']);

    // Only two artifacts exist, both happen to be protected
    const artifacts = [
      artifact('1.0.0', '2025-01-01T00:00:00Z'),
      artifact('2.0.0', '2025-01-02T00:00:00Z'),
    ];

    const plan = computeDeletionPlan(artifacts, protectedVersions, 0);

    expect(plan.toDelete).toHaveLength(0);
    expect(plan.toRetain).toHaveLength(2);
  });

  it('never deletes anything when protected set is a superset of artifact versions', () => {
    const protectedVersions = new Set(['a', 'b', 'c', 'd', 'e', 'f']);

    const artifacts = [
      artifact('a', '2025-01-01T00:00:00Z'),
      artifact('c', '2025-01-02T00:00:00Z'),
    ];

    const plan = computeDeletionPlan(artifacts, protectedVersions, 0);

    expect(plan.toDelete).toHaveLength(0);
    expect(plan.toRetain).toHaveLength(2);
  });
});
