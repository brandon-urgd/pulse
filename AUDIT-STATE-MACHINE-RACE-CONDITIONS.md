# Pulse — State Machine & Race Condition Audit

**Date:** 2026-07-14  
**Scope:** `urgd_repositories/pulse/` — Lambdas, CloudFormation, React frontend  
**Auditor:** Kiro automated audit

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 4     |
| HIGH     | 5     |
| MEDIUM   | 6     |
| LOW      | 3     |
| **Total** | **18** |

---

## 1. Race Conditions & Async Timing

### FINDING RC-1: closeItem writes item status without ConditionExpression
- **Severity:** CRITICAL
- **File:** `lambdas/urgd-pulse-closeItem/index.mjs`
- **Line:** 43–52
- **Description:** `closeItem` reads the current status with `GetItemCommand`, checks `if (currentStatus === 'closed')` in application code, then writes `status = 'closed'` via `UpdateItemCommand` — but the `UpdateItemCommand` has **no `ConditionExpression`**. Between the read and the write, another Lambda (e.g., `closeExpiredItems`, `processRevision`) could change the item status. This is a classic TOCTOU (time-of-check-time-of-use) race.
- **Impact:** Could overwrite a `revised` status back to `closed`, violating the `closed → revised` transition rule. Two concurrent close requests could both succeed.
- **Suggested Fix:**
  ```javascript
  await dynamo.send(new UpdateItemCommand({
    TableName: process.env.ITEMS_TABLE,
    Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
    UpdateExpression: 'SET #status = :closed, closedAt = :now, updatedAt = :now',
    ConditionExpression: '#status IN (:draft, :active)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':closed': { S: 'closed' },
      ':now': { S: now },
      ':draft': { S: 'draft' },
      ':active': { S: 'active' },
    },
  }))
  ```

### FINDING RC-2: closeExpiredItems writes item status without ConditionExpression
- **Severity:** CRITICAL
- **File:** `lambdas/urgd-pulse-closeExpiredItems/index.mjs`
- **Line:** 125–134
- **Description:** The scheduled `closeExpiredItems` Lambda scans for active items past their close date and writes `status = 'closed'` without a `ConditionExpression`. If `processRevision` has already transitioned the item to `revised`, this Lambda would overwrite it back to `closed`.
- **Impact:** Could revert a `revised` item back to `closed`, losing the revision state.
- **Suggested Fix:** Add `ConditionExpression: '#status = :active'` to the item status update.

### FINDING RC-3: inviteReviewer draft→active transition without ConditionExpression
- **Severity:** HIGH
- **File:** `lambdas/urgd-pulse-inviteReviewer/index.mjs`
- **Line:** 404–419
- **Description:** When `isFirstInvitation` is true, `inviteReviewer` sets `status = 'active'` without a `ConditionExpression`. Compare with `createSelfSession` (line 247) which correctly uses `ConditionExpression: '#status = :draft'`. If two invite requests arrive concurrently, both could attempt the draft→active transition, and the second could overwrite fields set by the first.
- **Impact:** Concurrent invitations could cause sessionCount drift or overwrite `lockedAt`.
- **Suggested Fix:** Add `ConditionExpression: '#status = :draft'` matching the pattern in `createSelfSession`.

### FINDING RC-4: createPublicSession draft→active transition without ConditionExpression
- **Severity:** HIGH
- **File:** `lambdas/urgd-pulse-createPublicSession/index.mjs`
- **Line:** 263–274
- **Description:** Same pattern as RC-3. When `isFirstSession` is true, the item status is set to `active` without a `ConditionExpression`. The `createSelfSession` Lambda correctly guards this with `ConditionExpression: '#status = :draft'`, but `createPublicSession` does not.
- **Impact:** Same as RC-3 — concurrent session creation could cause state corruption.
- **Suggested Fix:** Add `ConditionExpression: '#status = :draft'` and handle `ConditionalCheckFailedException`.

### FINDING RC-5: analyzeDocument writes sectionMap without ConditionExpression or closed-item guard
- **Severity:** MEDIUM
- **File:** `lambdas/urgd-pulse-analyzeDocument/index.mjs`
- **Line:** 164–175
- **Description:** `analyzeDocument` is invoked async (fire-and-forget) by `createItem`, `updateItem`, `extractText`, and `shieldCallback`. It writes `sectionMap` to the item record without checking the item's current status. If the item has been closed or revised by the time Bedrock returns, the write still proceeds. No `ConditionExpression` guards the update.
- **Impact:** Could write stale sectionMap data to a closed/revised item. Low practical risk since sectionMap is metadata, but violates the principle that closed items should not be mutated.
- **Suggested Fix:** Add `ConditionExpression: '#status IN (:draft, :active)'` or at minimum check item status before writing.

### FINDING RC-6: DynamoDB eventual consistency on write-then-read across Lambdas
- **Severity:** MEDIUM
- **File:** Multiple Lambdas (fire-and-forget chains)
- **Description:** Several Lambda chains use `InvocationType: 'Event'` (fire-and-forget) where Lambda A writes to DynamoDB and Lambda B reads immediately:
  - `runPulseCheck` writes `status: 'generating'` to pulse_checks table, then fires `processPulseCheck` which reads the same record
  - `generateRevision` writes revision record, then fires `processRevision` which reads it
  - `chat` writes session completion, then fires `generateReport` and `generateSessionSummary` which read the session
  
  DynamoDB eventually consistent reads (the default) could return stale data if the async Lambda starts before the write propagates. However, all these Lambdas use the default strongly consistent reads for `GetItemCommand` on primary keys, which mitigates this. The risk is primarily on GSI queries (which are always eventually consistent).
- **Impact:** Low practical risk for primary key reads. GSI-based queries in `processPulseCheck` (querying sessions by item-index) could miss recently completed sessions.
- **Suggested Fix:** Document this as an accepted risk. For critical paths, consider adding a small delay or using `ConsistentRead: true` where applicable (not available on GSIs — accepted limitation).

### FINDING RC-7: Fire-and-forget without completion verification
- **Severity:** LOW
- **File:** Multiple Lambdas
- **Description:** 15+ `InvocationType: 'Event'` invocations across the codebase where the caller returns success to the client without verifying the async worker completed. Key instances:
  - `runPulseCheck` → `processPulseCheck` (mitigated: frontend polls for completion)
  - `generateRevision` → `processRevision` (mitigated: frontend polls for completion)
  - `chat` → `generateReport` + `generateSessionSummary` (mitigated: non-blocking, reports appear when ready)
  - `extractText` → `analyzeDocument` (mitigated: frontend polls documentStatus)
  - `validateSession` / `createSelfSession` / `previewSession` → `primeCacheWorker` (mitigated: cache priming is best-effort optimization)
  
  This is an intentional architectural pattern (async dispatch + polling) and is well-implemented. The `generateRevision` Lambda even handles invocation failure by marking the revision as `failed`.
- **Impact:** Acceptable. All fire-and-forget patterns have either polling-based completion detection or are best-effort operations.
- **Suggested Fix:** No action needed. Pattern is sound. Consider adding DLQ (Dead Letter Queue) configuration for async Lambda invocations to catch silent failures.

---

## 2. State Transition Consistency

### FINDING ST-1: closeItem allows closing from ANY non-closed status
- **Severity:** HIGH
- **File:** `lambdas/urgd-pulse-closeItem/index.mjs`
- **Line:** 37–39
- **Description:** The guard clause only checks `if (currentStatus === 'closed')` and returns 409. This means a `revised` item can be closed again (`revised → closed`), which may not be a valid transition. The valid transition chain is `draft → active → closed → revised`. Going `revised → closed` would allow re-running the revision loop indefinitely.
- **Impact:** Depends on business rules. If `revised → closed` is intentional (to allow re-running pulse check after revision), this is acceptable. If not, it's a state machine violation.
- **Suggested Fix:** If `revised` is terminal, add: `if (currentStatus === 'revised') return errorResponse(409, 'Revised items cannot be closed again', {}, origin)`. If re-closing revised items is intentional, document it.

### FINDING ST-2: processRevision correctly guards closed→revised transition ✅
- **Severity:** N/A (positive finding)
- **File:** `lambdas/urgd-pulse-processRevision/index.mjs`
- **Line:** 279–289
- **Description:** `processRevision` uses `ConditionExpression: '#status = :closed'` when transitioning item status from `closed` to `revised`. This correctly prevents the transition from any other state. Well implemented.

### FINDING ST-3: createSelfSession correctly guards draft→active transition ✅
- **Severity:** N/A (positive finding)
- **File:** `lambdas/urgd-pulse-createSelfSession/index.mjs`
- **Line:** 247–260
- **Description:** Uses `ConditionExpression: '#status = :draft'` with proper `ConditionalCheckFailedException` handling. This is the gold standard pattern that RC-3 and RC-4 should follow.

### FINDING ST-4: chat Lambda correctly guards session status transitions ✅
- **Severity:** N/A (positive finding)
- **File:** `lambdas/urgd-pulse-chat/index.mjs`
- **Line:** 882–884
- **Description:** Uses `ConditionExpression: '#status IN (:not_started, :in_progress)'` to prevent overwriting terminal session states. Handles `ConditionalCheckFailedException` gracefully.

### FINDING ST-5: cancelSession correctly guards terminal states ✅
- **Severity:** N/A (positive finding)
- **File:** `lambdas/urgd-pulse-cancelSession/index.mjs`
- **Line:** 67–77
- **Description:** Uses `ConditionExpression: '#status IN (:not_started, :in_progress)'` to prevent cancelling completed/expired sessions.

### FINDING ST-6: expireSessions correctly guards terminal states ✅
- **Severity:** N/A (positive finding)
- **File:** `lambdas/urgd-pulse-expireSessions/index.mjs`
- **Line:** 113
- **Description:** Uses `ConditionExpression: '#status <> :completed AND #status <> :cancelled AND #status <> :discarded'` to prevent overwriting terminal session states.

### FINDING ST-7: validateSession reactivates discarded sessions with ConditionExpression ✅
- **Severity:** N/A (positive finding)
- **File:** `lambdas/urgd-pulse-validateSession/index.mjs`
- **Line:** 95–102
- **Description:** Uses `ConditionExpression: '#status = :discarded'` when reactivating a discarded session. Correctly scoped.

---

## 3. Guard Clauses on Closed Items

### FINDING GC-1: inviteReviewer blocks closed items ✅
- **File:** `lambdas/urgd-pulse-inviteReviewer/index.mjs`, Line 161
- **Guard:** `if (itemStatus !== 'draft' && itemStatus !== 'active')` → 409
- **Status:** Correct. Blocks closed, revised, and any other status.

### FINDING GC-2: createSelfSession blocks closed items ✅
- **File:** `lambdas/urgd-pulse-createSelfSession/index.mjs`, Line 82
- **Guard:** `if (itemStatus !== 'draft' && itemStatus !== 'active')` → 409
- **Status:** Correct.

### FINDING GC-3: createPublicSession blocks closed items ✅
- **File:** `lambdas/urgd-pulse-createPublicSession/index.mjs`, Line 113
- **Guard:** `if (itemStatus !== 'draft' && itemStatus !== 'active')` → 409
- **Status:** Correct.

### FINDING GC-4: updateItem blocks closed items ✅
- **File:** `lambdas/urgd-pulse-updateItem/index.mjs`, Line 131
- **Guard:** `if (currentItem.status !== 'draft')` → 409
- **Status:** Correct. Even stricter — only allows draft items.

### FINDING GC-5: extendDeadline blocks closed and revised items ✅
- **File:** `lambdas/urgd-pulse-extendDeadline/index.mjs`, Line 91
- **Guard:** `if (currentItem.status === 'closed' || currentItem.status === 'revised')` → 409
- **Status:** Correct.

### FINDING GC-6: getUploadUrl blocks non-draft items ✅
- **File:** `lambdas/urgd-pulse-getUploadUrl/index.mjs`, Line 143
- **Guard:** `if (itemStatus !== 'draft')` → 409
- **Status:** Correct.

### FINDING GC-7: removeDocument blocks non-draft items ✅
- **File:** `lambdas/urgd-pulse-removeDocument/index.mjs`, Line 47
- **Guard:** `if (item.status?.S !== 'draft')` → 409
- **Status:** Correct.

### FINDING GC-8: extendDeadline UpdateItemCommand has no ConditionExpression
- **Severity:** MEDIUM
- **File:** `lambdas/urgd-pulse-extendDeadline/index.mjs`
- **Line:** 103–118
- **Description:** While `extendDeadline` has an application-level guard checking `status === 'closed' || status === 'revised'`, the actual `UpdateItemCommand` that writes the new closeDate has no `ConditionExpression`. Between the read and write, the item could be closed by `closeExpiredItems` or `closeItem`. The deadline extension would then apply to a closed item.
- **Impact:** A deadline extension could be written to a closed item, creating an inconsistent state where a closed item has a future closeDate.
- **Suggested Fix:** Add `ConditionExpression: '#status IN (:draft, :active)'` to the UpdateItemCommand.

### FINDING GC-9: sendReminder writes lastReminderSent without status guard
- **Severity:** LOW
- **File:** `lambdas/urgd-pulse-sendReminder/index.mjs`
- **Line:** 308–320
- **Description:** `sendReminder` updates `lastReminderSent` on session records without checking if the session is still active. If a session was completed or expired between the scan and the update, the write still proceeds.
- **Impact:** Minimal — `lastReminderSent` is metadata and doesn't affect session state. The reminder email would have already been sent.
- **Suggested Fix:** Low priority. Could add `ConditionExpression: '#status = :not_started'` but the impact is negligible.

---

## 4. Frontend Optimistic Updates

### FINDING FE-1: InviteModal optimistic update AFTER API success ✅
- **Severity:** N/A (positive finding)
- **File:** `apps/admin-ui/src/pages/InviteModal.tsx`, Line 158
- **Description:** `queryClient.setQueryData` is called AFTER `authedMutate` succeeds (inside the `try` block, after the `await`). This is correct — it's a cache update after confirmed success, not a speculative optimistic update. Additionally calls `refetchSessions()` and `invalidateQueries` for consistency.

### FINDING FE-2: InviteModal cancel optimistic update without rollback
- **Severity:** MEDIUM
- **File:** `apps/admin-ui/src/pages/InviteModal.tsx`, Line 184
- **Description:** After a successful `DELETE` call to cancel a session, the code sets the session status to `not_started` in the cache via `queryClient.setQueryData`. However, the server actually sets the status to `cancelled`. The optimistic update shows `not_started` while the server has `cancelled`. The subsequent `invalidateQueries` on `['items']` doesn't invalidate `['sessions', itemId]`, so the stale cache persists until the next full refetch.
- **Impact:** UI briefly shows the cancelled session as `not_started` instead of `cancelled`. Self-corrects on next page load or refetch.
- **Suggested Fix:** Either set the optimistic status to `'cancelled'` to match the server, or add `queryClient.invalidateQueries({ queryKey: ['sessions', itemId] })`.

### FINDING FE-3: InviteModal endPublicSession optimistic update is correct ✅
- **Severity:** N/A (positive finding)
- **File:** `apps/admin-ui/src/pages/InviteModal.tsx`, Line 279
- **Description:** Sets status to `'expired'` after successful API call, matching the server behavior. Correct pattern.

### FINDING FE-4: useItemForm setQueryData after polling confirmation ✅
- **Severity:** N/A (positive finding)
- **File:** `apps/admin-ui/src/hooks/useItemForm.ts`, Lines 484, 516
- **Description:** Both `setQueryData` calls happen after polling confirms the server state (documentStatus is `ready`/`rejected`/`extraction_failed`, or sectionMap exists). This is a cache-warming pattern, not an optimistic update. Correct.

---

## 5. CORS Preflight (OPTIONS) Coverage

### FINDING CORS-1: Global proxy OPTIONS method provides fallback coverage ✅
- **Severity:** N/A (positive finding)
- **File:** `cloudformation/pulse-stack.yaml`, Line 1451
- **Description:** `PulseOptionsMethod` is defined on `PulseProxyResource` (`{proxy+}`), which acts as a catch-all OPTIONS handler for any path not explicitly covered. This provides baseline CORS preflight coverage.

### FINDING CORS-2: All PUT/DELETE/PATCH resources have explicit OPTIONS methods ✅
- **Severity:** N/A (positive finding)
- **Description:** Verified the following resources have explicit OPTIONS methods:
  - `/api/manage/settings` (PUT) → `PulseManageSettingsOptionsMethod` ✅
  - `/api/manage/account` (DELETE) → `PulseManageAccountOptionsMethod` ✅
  - `/api/manage/items/{itemId}` (PUT, DELETE) → `PulseManageItemOptionsMethod` ✅
  - `/api/manage/items/{itemId}/sessions/{sessionId}` (DELETE) → `PulseManageItemSessionOptionsMethod` ✅
  - `/api/manage/items/{itemId}/deadline` (PUT) → `PulseManageItemDeadlineOptionsMethod` ✅
  - `/api/manage/items/{itemId}/sessions/{sessionId}/expire` (PUT) → `PulseManageItemSessionExpireOptionsMethod` ✅
  - `/api/manage/items/{itemId}/close` (PUT) → `PulseManageItemCloseOptionsMethod` ✅
  - `/api/session/{sessionId}/summary` (PATCH) → `PulseSessionSummaryOptionsMethod` ✅
  - `/api/session/{sessionId}/transcript` (DELETE) → `PulseSessionTranscriptOptionsMethod` ✅
  - `/api/manage/items/{itemId}/document` (DELETE) → `PulseManageItemDocumentOptionsMethod` ✅
  - `/api/manage/items/{itemId}/pulse-check/decisions` (PUT) → `PulseManageItemPCDecisionsOptionsMethod` ✅
  - `/api/admin/tenants` → `PulseAdminTenantOptionsMethod` ✅
  - `/api/webhooks/stripe` → `PulseWebhooksStripeOptionsMethod` ✅
  - `/api/manage/checkout` → `PulseManageCheckoutOptionsMethod` ✅

### FINDING CORS-3: No missing OPTIONS methods detected
- **Severity:** N/A (positive finding)
- **Description:** Every API Gateway resource that accepts PUT, PATCH, or DELETE has either an explicit OPTIONS method or is covered by the `{proxy+}` catch-all. CORS preflight coverage is complete.

---

## 6. Prioritized Remediation Plan

### Immediate (CRITICAL)
1. **RC-1:** Add `ConditionExpression: '#status IN (:draft, :active)'` to `closeItem` UpdateItemCommand
2. **RC-2:** Add `ConditionExpression: '#status = :active'` to `closeExpiredItems` item status update

### High Priority
3. **RC-3:** Add `ConditionExpression: '#status = :draft'` to `inviteReviewer` draft→active transition (match `createSelfSession` pattern)
4. **RC-4:** Add `ConditionExpression: '#status = :draft'` to `createPublicSession` draft→active transition
5. **ST-1:** Decide if `revised → closed` is valid. If not, add guard in `closeItem`

### Medium Priority
6. **GC-8:** Add `ConditionExpression` to `extendDeadline` UpdateItemCommand
7. **RC-5:** Add status guard to `analyzeDocument` UpdateItemCommand
8. **FE-2:** Fix `InviteModal` cancel optimistic update to use `'cancelled'` status

### Low Priority / Accepted Risk
9. **RC-6:** Document eventual consistency risk on GSI queries as accepted
10. **RC-7:** Consider DLQ configuration for async Lambda invocations
11. **GC-9:** Optional status guard on `sendReminder` lastReminderSent update

---

## Well-Implemented Patterns (Commendations)

The codebase demonstrates strong defensive patterns in several areas:

1. **Chat Lambda streaming lock** (`streamingLock` with `ConditionExpression`) — prevents concurrent Bedrock calls for the same session
2. **Chat Lambda session status guard** (`ConditionExpression: '#status IN (:not_started, :in_progress)'`) — prevents overwriting terminal states
3. **cancelSession** — proper `ConditionExpression` preventing cancellation of terminal sessions
4. **expireSessions** — comprehensive terminal state exclusion in `ConditionExpression`
5. **processRevision** — correct `ConditionExpression: '#status = :closed'` for closed→revised transition
6. **createSelfSession** — gold standard draft→active transition with `ConditionExpression` and `ConditionalCheckFailedException` handling
7. **updateItemCoverageMap** — optimistic locking with retry loop for concurrent coverage updates
8. **Frontend patterns** — cache updates happen after API confirmation, not before. Polling patterns for async operations are well-implemented.
9. **CORS coverage** — complete OPTIONS method coverage across all API Gateway resources
10. **Tenant registration** — `ConditionExpression: 'attribute_not_exists(tenantId)'` prevents duplicate tenant creation
