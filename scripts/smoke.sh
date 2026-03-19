#!/usr/bin/env bash
set -euo pipefail

# Smoke tests for pulse
# Usage: ./scripts/smoke.sh <API_BASE_URL>

BASE_URL="$1"
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

# S0 gate: /v1/health → 200 { "status": "healthy" }
echo "Testing Health endpoint..."
if retry_check "Health" "curl -f -s --max-time 10 '$BASE_URL/v1/health' | jq -e '.status == \"healthy\"'"; then
  echo "✅ GET /v1/health → healthy"
else
  echo "❌ GET /v1/health FAILED (expected 200 { status: healthy })"
  fail=1
fi

# S0 gate: /v1/bedrock/health → 200 { "status": "degraded" }
echo "Testing Bedrock health endpoint..."
if retry_check "BedrockHealth" "curl -f -s --max-time 10 '$BASE_URL/v1/bedrock/health' | jq -e '.status == \"degraded\"'"; then
  echo "✅ GET /v1/bedrock/health → degraded"
else
  echo "❌ GET /v1/bedrock/health FAILED (expected 200 { status: degraded })"
  fail=1
fi

# S4 gate: session routes exist and reject unauthenticated requests (401)
# These are auth-gated — no token means 401, which confirms the route + authorizer are wired up
check "S4 POST /api/session/{id}/chat reachable"          "$BASE_URL/api/session/smoke-test/chat"          "401"
check "S4 GET /api/session/{id}/state reachable"          "$BASE_URL/api/session/smoke-test/state"         "401"
check "S4 GET /api/session/{id}/summary reachable"        "$BASE_URL/api/session/smoke-test/summary"       "401"
check "S4 DELETE /api/session/{id}/transcript reachable"  "$BASE_URL/api/session/smoke-test/transcript"    "401"
check "S4 GET /api/session/{id}/files/{fid} reachable"    "$BASE_URL/api/session/smoke-test/files/abc123"  "401"
check "S4 GET /api/manage/items/{id}/document-url reachable" "$BASE_URL/api/manage/items/smoke-test/document-url" "401"

# Summary
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
