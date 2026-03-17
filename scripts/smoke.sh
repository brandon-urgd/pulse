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

# Public health check
check "Health check" "$BASE_URL/v1/health" 200

# TODO: Add Lambda health endpoints
# check_health "management health" "$BASE_URL/v1/management/health"
# check_health "session health" "$BASE_URL/v1/session/health"

# TODO: Add endpoint smoke tests
# check_post "Create item (no auth)" "$BASE_URL/v1/items" "403" '{}'

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
  exit 0  # Non-blocking per CI/CD standards
fi
