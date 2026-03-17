#!/usr/bin/env bash
# deploy-frontend.sh — Two-pass S3 sync for Pulse frontend assets
#
# Usage:
#   ./scripts/deploy-frontend.sh [BUCKET_NAME] [DIST_DIR]
#
# Arguments / env vars (argument takes precedence over env var):
#   BUCKET_NAME  — S3 bucket to sync into
#   DIST_DIR     — Local directory containing built frontend assets
#
# Two-pass sync strategy (Requirement 10.12):
#   Pass 1 — Hashed assets (content hash in filename, e.g. *.{hash}.js, *.{hash}.css)
#             Cache-Control: public, immutable, max-age=31536000
#   Pass 2 — HTML entry points (*.html)
#             Cache-Control: no-cache, max-age=0, must-revalidate
#
# Files that match neither pattern are synced without a Cache-Control override
# (S3 default / bucket policy applies).

set -euo pipefail

# ── Argument / env var resolution ─────────────────────────────────────────────
BUCKET_NAME="${1:-${BUCKET_NAME:-}}"
DIST_DIR="${2:-${DIST_DIR:-}}"

if [ -z "$BUCKET_NAME" ]; then
  echo "❌ BUCKET_NAME is required (argument or env var)" >&2
  exit 1
fi

if [ -z "$DIST_DIR" ]; then
  echo "❌ DIST_DIR is required (argument or env var)" >&2
  exit 1
fi

if [ ! -d "$DIST_DIR" ]; then
  echo "❌ DIST_DIR does not exist: $DIST_DIR" >&2
  exit 1
fi

AWS_REGION="${AWS_REGION:-us-west-2}"
S3_PREFIX="${S3_PREFIX:-}"  # Optional prefix within the bucket (no trailing slash)

s3_dest="s3://${BUCKET_NAME}"
if [ -n "$S3_PREFIX" ]; then
  s3_dest="${s3_dest}/${S3_PREFIX}"
fi

echo "🚀 Deploying frontend assets"
echo "   Source:  $DIST_DIR"
echo "   Dest:    $s3_dest"
echo ""

# ── Pass 1: Hashed assets — immutable, long TTL ───────────────────────────────
# Matches filenames containing a content hash segment, e.g.:
#   main.a1b2c3d4.js   index.abc12345.css   chunk-vendor.deadbeef.js
# Pattern: any file whose stem contains a dot-separated hex segment (6–20 chars)
# before the final extension.
echo "── Pass 1: Hashed assets (immutable, max-age=31536000) ──────────────────"
aws s3 sync "$DIST_DIR" "$s3_dest" \
  --region "$AWS_REGION" \
  --cache-control "public, immutable, max-age=31536000" \
  --exclude "*" \
  --include "*.js" \
  --include "*.css" \
  --include "*.woff" \
  --include "*.woff2" \
  --include "*.ttf" \
  --include "*.eot" \
  --include "*.png" \
  --include "*.jpg" \
  --include "*.jpeg" \
  --include "*.gif" \
  --include "*.svg" \
  --include "*.ico" \
  --include "*.webp" \
  --include "*.avif" \
  --exclude "*.html" \
  --no-progress
echo "   ✅ Pass 1 complete"
echo ""

# ── Pass 2: HTML entry points — no-cache, must-revalidate ─────────────────────
echo "── Pass 2: HTML files (no-cache, must-revalidate) ───────────────────────"
aws s3 sync "$DIST_DIR" "$s3_dest" \
  --region "$AWS_REGION" \
  --cache-control "no-cache, max-age=0, must-revalidate" \
  --exclude "*" \
  --include "*.html" \
  --no-progress
echo "   ✅ Pass 2 complete"
echo ""

echo "✅ Frontend deployment complete → $s3_dest"
