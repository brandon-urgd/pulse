#!/usr/bin/env bash
set -euo pipefail

# Preconditions check for pulse deployments
# Usage: ./scripts/preconditions_check.sh <target_environment> <app_name> <base_url>
# Checks the SOURCE environment health before promoting to target.

TARGET_ENVIRONMENT="$1"
APP_NAME="$2"
BASE_URL="$3"

if [ "$TARGET_ENVIRONMENT" == "staging" ]; then
  SOURCE_ENVIRONMENT="dev"
elif [ "$TARGET_ENVIRONMENT" == "prod" ]; then
  SOURCE_ENVIRONMENT="staging"
else
  echo "❌ Invalid target environment: $TARGET_ENVIRONMENT"
  exit 1
fi

echo "🔍 Checking preconditions for $TARGET_ENVIRONMENT promotion..."
echo "📋 Source environment: $SOURCE_ENVIRONMENT"

CONFIG_FILE="config/preconditions.json"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "❌ Preconditions config not found: $CONFIG_FILE"
  exit 1
fi

LATENCY_MAX=$(jq -r ".$SOURCE_ENVIRONMENT.api_latency_ms_p95_max" "$CONFIG_FILE")
ERROR_MAX=$(jq -r ".$SOURCE_ENVIRONMENT.api_5xx_sum_max" "$CONFIG_FILE")
REQUIRE_WAF=$(jq -r ".$SOURCE_ENVIRONMENT.require_waf" "$CONFIG_FILE")
WINDOW_MINUTES=$(jq -r ".$SOURCE_ENVIRONMENT.window_minutes" "$CONFIG_FILE")
ALLOW_ACTIVE_ALARMS=$(jq -r ".$SOURCE_ENVIRONMENT.allow_active_alarms" "$CONFIG_FILE")

echo "📊 Thresholds ($SOURCE_ENVIRONMENT): latency≤${LATENCY_MAX}ms, 5xx≤${ERROR_MAX}, waf=$REQUIRE_WAF, window=${WINDOW_MINUTES}m"

all_passed=true
results=()
warnings=()

retry_check() {
  local name="$1" cmd="$2" max=3 delay=5
  for attempt in $(seq 1 $max); do
    if eval "$cmd" >/dev/null 2>&1; then return 0; fi
    [ $attempt -lt $max ] && echo "⚠️  $name failed (attempt $attempt/$max), retrying in ${delay}s..." && sleep $delay
  done
  return 1
}

check_with_retry() {
  local name="$1" cmd="$2" critical="$3"
  if retry_check "$name" "$cmd"; then
    results+=("✅ $name")
  elif [ "$critical" = "true" ]; then
    results+=("❌ $name")
    all_passed=false
  else
    warnings+=("⚠️  $name")
  fi
}

# Derive source URL from target URL
SOURCE_BASE_URL=$(echo "$BASE_URL" | sed "s/$APP_NAME-$TARGET_ENVIRONMENT/$APP_NAME-$SOURCE_ENVIRONMENT/")
echo "🔗 Source URL: $SOURCE_BASE_URL"

# 1. Public health check
check_with_retry "Public health check" \
  "curl -f -s --max-time 10 '$SOURCE_BASE_URL/v1/health' | jq -e '.status == \"healthy\"'" \
  "true"

# 2. CloudWatch metrics
END_TIME=$(date -u +%Y-%m-%dT%H:%M:%S)
if command -v gdate >/dev/null 2>&1; then
  START_TIME=$(gdate -u -d "${WINDOW_MINUTES} minutes ago" +%Y-%m-%dT%H:%M:%S)
else
  START_TIME=$(date -u -v-${WINDOW_MINUTES}M +%Y-%m-%dT%H:%M:%S)
fi

LATENCY_METRIC=$(aws cloudwatch get-metric-statistics \
  --namespace AWS/ApiGateway \
  --metric-name Latency \
  --dimensions Name=ApiName,Value="urgd-$APP_NAME-$SOURCE_ENVIRONMENT" \
  --statistics Average \
  --start-time "$START_TIME" --end-time "$END_TIME" --period 900 \
  --region us-west-2 --query 'Datapoints[0].Average' --output text 2>/dev/null || echo "null")

if [ "$LATENCY_METRIC" != "null" ] && [ "$LATENCY_METRIC" != "None" ]; then
  LATENCY_MS=$(echo "$LATENCY_METRIC * 1000" | bc -l | cut -d. -f1)
  [ "$LATENCY_MS" -le "$LATENCY_MAX" ] \
    && results+=("✅ API latency (${LATENCY_MS}ms ≤ ${LATENCY_MAX}ms)") \
    || warnings+=("⚠️  API latency (${LATENCY_MS}ms > ${LATENCY_MAX}ms)")
else
  warnings+=("⚠️  API latency (no data)")
fi

ERROR_METRIC=$(aws cloudwatch get-metric-statistics \
  --namespace AWS/ApiGateway \
  --metric-name 5XXError \
  --dimensions Name=ApiName,Value="urgd-$APP_NAME-$SOURCE_ENVIRONMENT" \
  --statistics Sum \
  --start-time "$START_TIME" --end-time "$END_TIME" --period 900 \
  --region us-west-2 --query 'Datapoints[0].Sum' --output text 2>/dev/null || echo "null")

if [ "$ERROR_METRIC" != "null" ] && [ "$ERROR_METRIC" != "None" ]; then
  ERROR_COUNT=$(echo "$ERROR_METRIC" | cut -d. -f1)
  [ "$ERROR_COUNT" -le "$ERROR_MAX" ] \
    && results+=("✅ API 5xx errors (${ERROR_COUNT} ≤ ${ERROR_MAX})") \
    || warnings+=("⚠️  API 5xx errors (${ERROR_COUNT} > ${ERROR_MAX})")
else
  warnings+=("⚠️  API 5xx errors (no data)")
fi

# 3. Active alarms
if [ "$ALLOW_ACTIVE_ALARMS" = "false" ]; then
  ACTIVE_ALARMS=$(aws cloudwatch describe-alarms \
    --state-value ALARM \
    --query "MetricAlarms[?contains(AlarmName, 'urgd-$APP_NAME') && contains(AlarmName, '$SOURCE_ENVIRONMENT')].AlarmName" \
    --output text --region us-west-2 2>/dev/null || echo "")
  [ -n "$ACTIVE_ALARMS" ] \
    && warnings+=("⚠️  Active alarms: $ACTIVE_ALARMS") \
    || results+=("✅ No active alarms")
else
  results+=("⏭️  Active alarms allowed")
fi

# 4. WAF binding
if [ "$REQUIRE_WAF" = "true" ]; then
  CLOUDFRONT_ID=$(aws cloudformation describe-stacks \
    --stack-name "urgd-$APP_NAME-$SOURCE_ENVIRONMENT" \
    --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDistributionId`].OutputValue' \
    --output text --region us-west-2 2>/dev/null || echo "")
  [ -n "$CLOUDFRONT_ID" ] && [ "$CLOUDFRONT_ID" != "None" ] \
    && results+=("✅ WAF binding verified") \
    || { results+=("❌ WAF binding not found"); all_passed=false; }
else
  results+=("⏭️  WAF not required")
fi

# 5. Stack status
STACK_STATUS=$(aws cloudformation describe-stacks \
  --stack-name "urgd-$APP_NAME-$SOURCE_ENVIRONMENT" \
  --query 'Stacks[0].StackStatus' --output text --region us-west-2 2>/dev/null || echo "NOT_FOUND")
[[ "$STACK_STATUS" == *"COMPLETE"* ]] \
  && results+=("✅ Stack healthy ($STACK_STATUS)") \
  || { results+=("❌ Stack unhealthy ($STACK_STATUS)"); all_passed=false; }

# Summary
echo ""
echo "## 📋 Preconditions Checklist"
for r in "${results[@]}"; do echo "  $r"; done
[ ${#warnings[@]} -gt 0 ] && echo "" && echo "## ⚠️  Warnings" && for w in "${warnings[@]}"; do echo "  $w"; done

echo ""
if [ "$all_passed" = true ]; then
  echo "✅ Preconditions passed (${#warnings[@]} warning(s))"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "all_passed=true" >> $GITHUB_OUTPUT
  exit 0
else
  echo "❌ Critical preconditions failed — blocking promotion to $TARGET_ENVIRONMENT"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "all_passed=false" >> $GITHUB_OUTPUT
  exit 1
fi
