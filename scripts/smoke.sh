#!/usr/bin/env bash
set -euo pipefail

# Smoke tests for pulse
# Usage: ./scripts/smoke.sh <API_BASE_URL> [ENVIRONMENT]

BASE_URL="$1"
ENVIRONMENT="${2:-}"
fail=0
warnings=0

echo "🧪 Running smoke tests against: $BASE_URL"

retry_check() {
  local name="$1" cmd="$2" max=3 delay=5
  for attempt in $(seq 1 $max); do
    if eval "$cmd" >/dev/null 2>&1; then return 0; fi
    [ $attempt -lt $max ] && echo "⚠️  $name failed (attempt $attempt/$max), retrying in ${delay}s..." && sleep $delay
  done
  return 1
}

check() {
  local name="$1" url="$2" expect="$3"
  echo "Testing $name..."
  if retry_check "$name" "curl -s -o /dev/null -w '%{http_code}' --max-time 10 '$url' | grep -q '$expect'"; then
    echo "✅ $name ($expect)"
  else
    echo "❌ $name FAILED (expected $expect)"
    fail=1
  fi
}

check_health() {
  local name="$1" url="$2"
  echo "Testing $name..."
  if retry_check "$name" "curl -f -s --max-time 10 '$url' | jq -e '.status == \"healthy\"'"; then
    echo "✅ $name (healthy)"
  else
    echo "⚠️  $name (unhealthy or unavailable)"
    warnings=$((warnings + 1))
  fi
}

check_post() {
  local name="$1" url="$2" expect="$3" data="$4"
  echo "Testing $name..."
  if retry_check "$name" "curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'Content-Type: application/json' -d '$data' '$url' | grep -q '$expect'"; then
    echo "✅ $name ($expect)"
  else
    echo "❌ $name FAILED (expected $expect)"
    fail=1
  fi
}

check_delete() {
  local name="$1" url="$2" expect="$3"
  echo "Testing $name..."
  if retry_check "$name" "curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X DELETE '$url' | grep -q '$expect'"; then
    echo "✅ $name ($expect)"
  else
    echo "❌ $name FAILED (expected $expect)"
    fail=1
  fi
}

check_put() {
  local name="$1" url="$2" expect="$3" data="$4"
  echo "Testing $name..."
  if retry_check "$name" "curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X PUT -H 'Content-Type: application/json' -d '$data' '$url' | grep -q '$expect'"; then
    echo "✅ $name ($expect)"
  else
    echo "❌ $name FAILED (expected $expect)"
    fail=1
  fi
}

# ── Health checks ──────────────────────────────────────────────────────────────

echo "Testing Health endpoint..."
if retry_check "Health" "curl -f -s --max-time 10 '$BASE_URL/v1/health' | jq -e '.status == \"healthy\"'"; then
  echo "✅ GET /v1/health → healthy"
else
  echo "❌ GET /v1/health FAILED (expected 200 { status: healthy })"
  fail=1
fi

# Bedrock cold starts can be slow — allow 30s per attempt.
# Bedrock availability is external — downgrade to warning so it doesn't block deploys.
echo "Testing Bedrock health endpoint..."
if retry_check "BedrockHealth" "curl -f -s --max-time 30 '$BASE_URL/v1/bedrock/health' | jq -e '.status == \"healthy\" or .status == \"degraded\"'"; then
  echo "✅ GET /v1/bedrock/health → healthy"
else
  echo "⚠️  GET /v1/bedrock/health (unhealthy or unavailable)"
  warnings=$((warnings + 1))
fi

# ── Auth & tenant management routes ───────────────────────────────────────────

check_post "POST /api/register reachable"                     "$BASE_URL/api/register"                        "403" "{}"
check      "GET /api/manage/settings reachable"               "$BASE_URL/api/manage/settings"                 "401"
check_put  "PUT /api/manage/settings reachable"               "$BASE_URL/api/manage/settings"                 "401" "{}"
check_delete "DELETE /api/manage/account reachable"           "$BASE_URL/api/manage/account"                  "401"

# ── Item CRUD routes ──────────────────────────────────────────────────────────

check      "GET /api/manage/items reachable"                  "$BASE_URL/api/manage/items"                    "401"
check_post "POST /api/manage/items reachable"                 "$BASE_URL/api/manage/items"                    "401" "{}"
check      "GET /api/manage/items/{id} reachable"             "$BASE_URL/api/manage/items/smoke-test"         "401"
check_put  "PUT /api/manage/items/{id} reachable"             "$BASE_URL/api/manage/items/smoke-test"         "401" "{}"
check_delete "DELETE /api/manage/items/{id} reachable"        "$BASE_URL/api/manage/items/smoke-test"         "401"

# ── Document management routes ────────────────────────────────────────────────

check      "GET /api/manage/items/{id}/upload-url reachable"  "$BASE_URL/api/manage/items/smoke-test/upload-url" "403"
check      "GET /api/manage/items/{id}/document-url reachable" "$BASE_URL/api/manage/items/smoke-test/document-url" "401"
check_delete "DELETE /api/manage/items/{id}/document reachable" "$BASE_URL/api/manage/items/smoke-test/document" "401"

# ── Session management routes ─────────────────────────────────────────────────

check_post "POST /api/manage/items/{id}/invite reachable"     "$BASE_URL/api/manage/items/smoke-test/invite"  "401" "{}"
check      "GET /api/manage/items/{id}/sessions reachable"    "$BASE_URL/api/manage/items/smoke-test/sessions" "401"
check_put  "PUT /api/manage/items/{id}/sessions/{sid} reachable" "$BASE_URL/api/manage/items/smoke-test/sessions/smoke-test" "403" "{}"
check_delete "DELETE /api/manage/items/{id}/sessions/{sid} reachable" "$BASE_URL/api/manage/items/smoke-test/sessions/smoke-test" "401"
check_put  "PUT /api/manage/items/{id}/deadline reachable"    "$BASE_URL/api/manage/items/smoke-test/deadline" "401" "{}"

# ── Public session routes ─────────────────────────────────────────────────────

check_post "POST /api/manage/items/{id}/public-session reachable" "$BASE_URL/api/manage/items/smoke-test/public-session" "401" "{}"
check      "GET /api/manage/items/{id}/sessions/{sid}/qr reachable" "$BASE_URL/api/manage/items/smoke-test/sessions/smoke-test/qr" "401"
check_put  "PUT /api/manage/items/{id}/sessions/{sid}/expire reachable" "$BASE_URL/api/manage/items/smoke-test/sessions/smoke-test/expire" "401" "{}"
check_put  "PUT /api/manage/items/{id}/close reachable"       "$BASE_URL/api/manage/items/smoke-test/close"   "401" "{}"

# ── Session flow routes (session auth) ────────────────────────────────────────

check_post "POST /api/session/{id}/chat reachable"            "$BASE_URL/api/session/smoke-test/chat"         "401" "{}"
check      "GET /api/session/{id}/state reachable"            "$BASE_URL/api/session/smoke-test/state"        "401"
check      "GET /api/session/{id}/summary reachable"          "$BASE_URL/api/session/smoke-test/summary"      "401"
check_delete "DELETE /api/session/{id}/transcript reachable"  "$BASE_URL/api/session/smoke-test/transcript"   "401"
check      "GET /api/session/{id}/files/{fid} reachable"      "$BASE_URL/api/session/smoke-test/files/abc123" "401"
check_post "POST /api/session/validate reachable"             "$BASE_URL/api/session/validate"                "400" "{}"
check_post "POST /api/session/{id}/accept-confidentiality reachable" "$BASE_URL/api/session/smoke-test/accept-confidentiality" "401" "{}"

# ── Report & PulseCheck routes ────────────────────────────────────────────────

check      "GET /api/manage/items/{id}/sessions/{sid}/report reachable" "$BASE_URL/api/manage/items/smoke-test/sessions/smoke-test/report" "401"
check_post "POST /api/manage/items/{id}/pulse-check reachable" "$BASE_URL/api/manage/items/smoke-test/pulse-check" "401" "{}"
check      "GET /api/manage/items/{id}/pulse-check reachable" "$BASE_URL/api/manage/items/smoke-test/pulse-check" "401"
check_put  "PUT /api/manage/items/{id}/pulse-check/decisions reachable" "$BASE_URL/api/manage/items/smoke-test/pulse-check/decisions" "401" "{}"

# ── Revision routes ───────────────────────────────────────────────────────────

check_post "POST /api/manage/items/{id}/revise reachable"     "$BASE_URL/api/manage/items/smoke-test/revise"  "401" "{}"
check      "GET /api/manage/items/{id}/revisions reachable"   "$BASE_URL/api/manage/items/smoke-test/revisions" "401"

# ── Preview & self-session routes ─────────────────────────────────────────────

check      "GET /api/manage/items/{id}/preview-session reachable" "$BASE_URL/api/manage/items/smoke-test/preview-session" "401"
check_post "POST /api/manage/items/{id}/self-review reachable" "$BASE_URL/api/manage/items/smoke-test/self-review" "401" "{}"
check_post "POST /api/session/{id}/report reachable"          "$BASE_URL/api/session/smoke-test/report"       "401" "{}"
check_post "POST /api/manage/report reachable"                "$BASE_URL/api/manage/report"                   "401" "{}"

# ── Admin & AI routes ─────────────────────────────────────────────────────────

check      "GET /api/admin/tenants reachable"                 "$BASE_URL/api/admin/tenants"                   "403"
check      "GET /api/public/config reachable"                  "$BASE_URL/api/public/config"                   "200"
check_post "POST /api/manage/items/{id}/suggest-description reachable" "$BASE_URL/api/manage/items/smoke-test/suggest-description" "401" "{}"

# ── Billing routes ────────────────────────────────────────────────────────────

check_post "POST /api/session/{id}/email-summary reachable"   "$BASE_URL/api/session/smoke-test/email-summary" "401" "{}"
check_post "POST /api/webhooks/stripe reachable"              "$BASE_URL/api/webhooks/stripe"                 "400" "{}"
check_post "POST /api/manage/checkout reachable"              "$BASE_URL/api/manage/checkout"                 "401" "{}"

# ── Lambda existence checks (async workers with no API Gateway route) ─────────

if [ -n "$ENVIRONMENT" ]; then
  echo ""
  echo "── Lambda function existence checks (async workers) ──"
  REGION="us-west-2"
  LAMBDA_FUNCTIONS=(
    "urgd-pulse-analyzeDocument-${ENVIRONMENT}"
    "urgd-pulse-closeExpiredItems-${ENVIRONMENT}"
    "urgd-pulse-createTenant-${ENVIRONMENT}"
    "urgd-pulse-expireSessions-${ENVIRONMENT}"
    "urgd-pulse-extractText-${ENVIRONMENT}"
    "urgd-pulse-generateReport-${ENVIRONMENT}"
    "urgd-pulse-generateSessionSummary-${ENVIRONMENT}"
    "urgd-pulse-processPulseCheck-${ENVIRONMENT}"
    "urgd-pulse-processRevision-${ENVIRONMENT}"
    "urgd-pulse-purgeTranscripts-${ENVIRONMENT}"
    "urgd-pulse-sendPulseCheckReady-${ENVIRONMENT}"
    "urgd-pulse-sendReminder-${ENVIRONMENT}"
    "urgd-pulse-shieldCallback-${ENVIRONMENT}"
    "urgd-pulse-usageReport-${ENVIRONMENT}"
    "urgd-pulse-renderPages-${ENVIRONMENT}"
  )
  for fn in "${LAMBDA_FUNCTIONS[@]}"; do
    echo "Testing Lambda $fn..."
    if retry_check "Lambda $fn" "aws lambda get-function --function-name '$fn' --region '$REGION'"; then
      echo "✅ Lambda $fn exists"
    else
      echo "❌ Lambda $fn NOT FOUND"
      fail=1
    fi
  done
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "## 📊 Smoke Test Summary"
echo "  Warnings: $warnings"
echo "  Failed:   $fail"

# Send CloudWatch metrics
aws cloudwatch put-metric-data \
  --namespace "Pulse/SmokeTests" \
  --metric-data MetricName=FailedTests,Value=$fail,Unit=Count \
  --region us-west-2 2>/dev/null || true

if [ $fail -eq 0 ] && [ $warnings -eq 0 ]; then
  echo "🎉 All smoke tests passed!"
  exit 0
elif [ $fail -eq 0 ]; then
  echo "⚠️  Smoke tests passed with $warnings warning(s)"
  exit 0
else
  echo "💥 Smoke tests failed!"
  exit 1
fi
