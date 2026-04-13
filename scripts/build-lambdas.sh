#!/usr/bin/env bash
# build-lambdas.sh — Build and upload Lambda ZIPs for Pulse
#
# Usage:
#   ./scripts/build-lambdas.sh [VERSION]
#
# If VERSION is not passed, it is derived from the git SHA.
# Uploads to: s3://${ARTIFACT_BUCKET}/lambda-packages/urgd-pulse-{fn}/{version}.zip
#
# Requirements: 2.5

set -euo pipefail

# ── Version resolution ────────────────────────────────────────────────────────
if [ -n "${1:-}" ]; then
  VERSION="$1"
elif [ -n "${VERSION:-}" ]; then
  VERSION="$VERSION"
elif git rev-parse --git-dir >/dev/null 2>&1; then
  VERSION=$(git rev-parse --short HEAD)
else
  echo "❌ Cannot determine version: pass as argument, set VERSION env var, or run inside a git repo" >&2
  exit 1
fi

# ── Required env vars ─────────────────────────────────────────────────────────
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-}"
if [ -z "$ARTIFACT_BUCKET" ]; then
  echo "❌ ARTIFACT_BUCKET env var is required" >&2
  exit 1
fi

AWS_REGION="${AWS_REGION:-us-west-2}"

# ── Paths ─────────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAMBDAS_DIR="$REPO_ROOT/lambdas"
SHARED_UTILS="$LAMBDAS_DIR/shared/utils.mjs"
BUILD_BASE="/tmp/pulse-lambda-builds-$$"

if [ ! -f "$SHARED_UTILS" ]; then
  echo "❌ shared/utils.mjs not found at $SHARED_UTILS" >&2
  exit 1
fi

mkdir -p "$BUILD_BASE"
trap 'rm -rf "$BUILD_BASE"' EXIT

echo "🔨 Building Lambda ZIPs — version: $VERSION"
echo "   Artifact bucket: $ARTIFACT_BUCKET"
echo ""

built=0
failed=0
MANIFEST_FUNCTIONS="[]"

for lambda_dir in "$LAMBDAS_DIR"/*/; do
  lambda_name=$(basename "$lambda_dir")

  # Skip the shared utilities directory
  if [ "$lambda_name" = "shared" ]; then
    continue
  fi

  # Skip container-based Lambdas (built as Docker images, not ZIPs)
  if [ -f "$lambda_dir/Dockerfile" ]; then
    echo "── $lambda_name ── (skipped — container-based Lambda)"
    echo ""
    continue
  fi

  echo "── $lambda_name ──────────────────────────────────────────────────────"

  BUILD_DIR="$BUILD_BASE/$lambda_name"
  mkdir -p "$BUILD_DIR"

  # Copy Lambda source files
  cp -r "$lambda_dir"/* "$BUILD_DIR/"

  # Copy shared/ directory into build dir (matches ./shared/utils.mjs import path per Lambda Standards)
  # Remove any existing shared symlink first (committed symlinks resolve incorrectly on CI runners)
  rm -rf "$BUILD_DIR/shared"
  cp -r "$LAMBDAS_DIR/shared" "$BUILD_DIR/shared"
  echo "   ✅ Copied shared/ directory"

  # Install npm dependencies if package.json is present
  if [ -f "$BUILD_DIR/package.json" ]; then
    echo "   📦 Installing npm dependencies..."
    (cd "$BUILD_DIR" && npm ci --omit=dev --silent)
    echo "   ✅ npm ci complete"
  fi

  # Create ZIP
  ZIP_FILE="$BUILD_BASE/${lambda_name}-${VERSION}.zip"
  (
    cd "$BUILD_DIR"
    zip -r "$ZIP_FILE" . \
      --exclude "*.git*" \
      --exclude "*.DS_Store*" \
      --exclude "node_modules/.cache/*" \
      --exclude "__pycache__/*" \
      --exclude "*.pyc" \
      --exclude "*.test.*" \
      --exclude "*.spec.*" \
      >/dev/null
  )
  echo "   ✅ Created ZIP: $(basename "$ZIP_FILE")"

  # Upload to S3 at lambda-packages/urgd-pulse-{fn}/{version}.zip
  S3_KEY="lambda-packages/${lambda_name}/${VERSION}.zip"
  aws s3 cp "$ZIP_FILE" "s3://${ARTIFACT_BUCKET}/${S3_KEY}" \
    --region "$AWS_REGION" \
    --no-progress
  echo "   ✅ Uploaded → s3://${ARTIFACT_BUCKET}/${S3_KEY}"

  # Accumulate manifest entry
  MANIFEST_FUNCTIONS=$(echo "$MANIFEST_FUNCTIONS" | \
    python3 -c "import sys,json; lst=json.load(sys.stdin); lst.append('${lambda_name}'); print(json.dumps(lst))")

  built=$((built + 1))
  echo ""
done

echo "✅ Build complete — $built Lambda(s) built and uploaded (version: $VERSION)"

if [ $built -eq 0 ]; then
  echo "❌ No Lambda functions found to build — check lambdas/ directory" >&2
  exit 1
fi

# ── Write and upload manifest ─────────────────────────────────────────────────
MANIFEST_FILE="$BUILD_BASE/lambda-manifest.json"
python3 -c "
import json, sys
functions = $MANIFEST_FUNCTIONS
manifest = {
    'version': '${VERSION}',
    'functions': functions,
    's3_keys': {fn: 'lambda-packages/' + fn + '/${VERSION}.zip' for fn in functions}
}
print(json.dumps(manifest, indent=2))
" > "$MANIFEST_FILE"

aws s3 cp "$MANIFEST_FILE" \
  "s3://${ARTIFACT_BUCKET}/lambda-packages/manifest-${VERSION}.json" \
  --region "$AWS_REGION" \
  --no-progress
echo "✅ Manifest uploaded → s3://${ARTIFACT_BUCKET}/lambda-packages/manifest-${VERSION}.json"
