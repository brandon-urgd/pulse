/**
 * compute-cleanup.mjs — Environment-aware artifact retention logic
 *
 * Pure functions for computing which S3 artifacts to delete during CI/CD cleanup.
 * Protected versions (currently deployed to dev/staging/prod) are never deleted.
 *
 * @module compute-cleanup
 */

/**
 * @typedef {Object} DeploymentMetadata
 * @property {string} version       - Deployed version identifier
 * @property {string} commit_sha    - Git commit SHA
 * @property {string} environment   - Target environment (dev, staging, prod)
 * @property {string} stack_name    - CloudFormation stack name
 * @property {string} deployed_by   - Actor that triggered the deploy
 * @property {string} build_time    - ISO-8601 build timestamp
 */

/**
 * @typedef {Object} ArtifactEntry
 * @property {string} key           - S3 object key
 * @property {string} version       - Extracted version identifier
 * @property {string} timestamp     - Last modified or build_time (ISO-8601)
 */

/**
 * @typedef {Object} DeletionPlan
 * @property {ArtifactEntry[]} toDelete           - Artifacts marked for removal
 * @property {ArtifactEntry[]} toRetain           - Artifacts to keep
 * @property {Set<string>}     protectedVersions  - Versions shielded by active deployments
 * @property {string[]}        warnings           - Non-fatal issues encountered
 */

/** Required fields on a valid DeploymentMetadata object */
const METADATA_REQUIRED_FIELDS = [
  'version',
  'commit_sha',
  'environment',
  'stack_name',
  'deployed_by',
  'build_time',
];

/**
 * Build a DeploymentMetadata object from individual parameters.
 * Throws if any required field is missing or not a non-empty string.
 *
 * @param {Object} params
 * @param {string} params.version
 * @param {string} params.commit_sha
 * @param {string} params.environment
 * @param {string} params.stack_name
 * @param {string} params.deployed_by
 * @param {string} params.build_time
 * @returns {DeploymentMetadata}
 */
export function buildDeploymentMetadata({ version, commit_sha, environment, stack_name, deployed_by, build_time }) {
  const params = { version, commit_sha, environment, stack_name, deployed_by, build_time };

  for (const field of METADATA_REQUIRED_FIELDS) {
    const value = params[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`buildDeploymentMetadata: "${field}" must be a non-empty string, got ${JSON.stringify(value)}`);
    }
  }

  return { version, commit_sha, environment, stack_name, deployed_by, build_time };
}

/**
 * Extract the set of protected versions from per-environment metadata.
 *
 * For each environment key in `metadataByEnv`:
 *  - If the value is null/undefined → add a warning, skip.
 *  - If the value exists but `version` is not a non-empty string → add a warning, skip.
 *  - Otherwise → add `version` to the protected set.
 *
 * Never throws.
 *
 * @param {Record<string, DeploymentMetadata | null>} metadataByEnv
 * @returns {{ protectedVersions: Set<string>, warnings: string[] }}
 */
export function extractProtectedVersions(metadataByEnv) {
  /** @type {Set<string>} */
  const protectedVersions = new Set();
  /** @type {string[]} */
  const warnings = [];

  if (metadataByEnv == null || typeof metadataByEnv !== 'object') {
    warnings.push('metadataByEnv is null or not an object — no protected versions extracted');
    return { protectedVersions, warnings };
  }

  for (const [env, metadata] of Object.entries(metadataByEnv)) {
    if (metadata == null) {
      warnings.push(`Environment "${env}": metadata is missing — no protected version for this environment`);
      continue;
    }

    const version = metadata.version;
    if (typeof version !== 'string' || version.trim() === '') {
      warnings.push(`Environment "${env}": version field is missing or empty — no protected version for this environment`);
      continue;
    }

    protectedVersions.add(version);
  }

  return { protectedVersions, warnings };
}

/**
 * Compute which artifacts to delete and which to retain.
 *
 * 1. Separate artifacts into protected (version ∈ protectedVersions) and unprotected.
 * 2. Sort unprotected by timestamp descending (most recent first).
 * 3. Retain the first `retainCount` unprotected artifacts.
 * 4. Mark the rest for deletion.
 * 5. Protected artifacts always go to `toRetain`.
 *
 * @param {ArtifactEntry[]} artifacts
 * @param {Set<string>}     protectedVersions
 * @param {number}           retainCount - Number of most-recent unprotected versions to keep
 * @returns {DeletionPlan}
 */
export function computeDeletionPlan(artifacts, protectedVersions, retainCount) {
  /** @type {string[]} */
  const warnings = [];

  // Defensive: ensure inputs are sane
  const safeArtifacts = Array.isArray(artifacts) ? artifacts : [];
  const safeProtected = protectedVersions instanceof Set ? protectedVersions : new Set();
  const safeRetain = typeof retainCount === 'number' && retainCount >= 0
    ? Math.floor(retainCount)
    : 0;

  // Partition into protected and unprotected
  /** @type {ArtifactEntry[]} */
  const protectedArtifacts = [];
  /** @type {ArtifactEntry[]} */
  const unprotectedArtifacts = [];

  for (const artifact of safeArtifacts) {
    if (safeProtected.has(artifact.version)) {
      protectedArtifacts.push(artifact);
    } else {
      unprotectedArtifacts.push(artifact);
    }
  }

  // Sort unprotected by timestamp descending (most recent first)
  unprotectedArtifacts.sort((a, b) => {
    const ta = a.timestamp || '';
    const tb = b.timestamp || '';
    if (ta > tb) return -1;
    if (ta < tb) return 1;
    return 0;
  });

  // Retain the first `safeRetain` unprotected, delete the rest
  const toRetainUnprotected = unprotectedArtifacts.slice(0, safeRetain);
  const toDelete = unprotectedArtifacts.slice(safeRetain);

  // All protected artifacts are always retained
  const toRetain = [...protectedArtifacts, ...toRetainUnprotected];

  return {
    toDelete,
    toRetain,
    protectedVersions: safeProtected,
    warnings,
  };
}
