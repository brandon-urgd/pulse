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

# S0 gate: /v1/health → 200 { "status": "healthy" }
echo "Testing Health endpoint..."
if retry_check "Health" "curl -f -s --max-time 10 '$BASE_URL/v1/health' | jq -e '.status == \"healthy\"'"; then
  echo "✅ GET /v1/health → healthy"
else
  echo "❌ GET /v1/health FAILED (expected 200 { status: healthy })"
  fail=1
fi

# Bedrock health → 200 { "status": "healthy" | "degraded" }
# Bedrock cold starts can be slow (SDK import + model invocation) — allow 30s per attempt.
# Bedrock availability is external — downgrade to warning so it doesn't block deploys.
echo "Testing Bedrock health endpoint..."
if retry_check "BedrockHealth" "curl -f -s --max-time 30 '$BASE_URL/v1/bedrock/health' | jq -e '.status == \"healthy\" or .status == \"degraded\"'"; then
  echo "✅ GET /v1/bedrock/health → healthy"
else
  echo "⚠️  GET /v1/bedrock/health (unhealthy or unavailable)"
  warnings=$((warnings + 1))
fi

# S4 gate: session routes exist and reject unauthenticated requests (401)
# These are auth-gated — no token means 401, which confirms the route + authorizer are wired up
check_post "S4 POST /api/session/{id}/chat reachable"         "$BASE_URL/api/session/smoke-test/chat"          "401" "{}"
check "S4 GET /api/session/{id}/state reachable"          "$BASE_URL/api/session/smoke-test/state"         "401"
check "S4 GET /api/session/{id}/summary reachable"        "$BASE_URL/api/session/smoke-test/summary"       "401"
check_delete "S4 DELETE /api/session/{id}/transcript reachable" "$BASE_URL/api/session/smoke-test/transcript" "401"
check "S4 GET /api/session/{id}/files/{fid} reachable"    "$BASE_URL/api/session/smoke-test/files/abc123"  "401"
check "S4 GET /api/manage/items/{id}/document-url reachable" "$BASE_URL/api/manage/items/smoke-test/document-url" "401"

# S5 gate: report and pulse check routes exist and reject unauthenticated requests (401)
check "S5 GET /api/manage/items/{id}/sessions/{sid}/report reachable" "$BASE_URL/api/manage/items/smoke-test/sessions/smoke-test/report" "401"
check_post "S5 POST /api/manage/items/{id}/pulse-check reachable"     "$BASE_URL/api/manage/items/smoke-test/pulse-check"              "401" "{}"
check "S5 GET /api/manage/items/{id}/pulse-check reachable"           "$BASE_URL/api/manage/items/smoke-test/pulse-check"              "401"
check_put "S5 PUT /api/manage/items/{id}/pulse-check/decisions reachable" "$BASE_URL/api/manage/items/smoke-test/pulse-check/decisions" "401" "{}"

# S6 gate: account deletion, revision generation, and revision listing routes
check_delete "S6 DELETE /api/manage/account reachable"                    "$BASE_URL/api/manage/account"                              "401"
check_post   "S6 POST /api/manage/items/{id}/revise reachable"            "$BASE_URL/api/manage/items/smoke-test/revise"              "401" "{}"
check        "S6 GET /api/manage/items/{id}/revisions reachable"          "$BASE_URL/api/manage/items/smoke-test/revisions"           "401"

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
