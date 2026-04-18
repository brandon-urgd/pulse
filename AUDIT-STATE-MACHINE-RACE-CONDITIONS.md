# Pulse State Machine & Race Condition Audit

**Date:** 2026-07-17
**Scope:** 64 Lambda functions, 7 DynamoDB tables, CloudFormation infrastructure
**Focus:** Recently modified counter-decrement Lambdas, async revision generation, CORS preflight

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 1     |
| HIGH     | 5     |
| MEDIUM   | 6     |
| LOW      | 3     |

---

## 1. State Transition Consistency

### Item Status Transitions: `draft → active → closed → revised`

| Lambda | Transition | ConditionExpression | Verdict |
|--------|-----------|-------------------|---------|
| closeItem | draft/active → closed | `#status IN (:draft, :active)` | ✅ |
| closeExpiredItems | active → closed | `#status = :active` | ✅ |
| processRevision | closed → revised | `#status = :closed` | ✅ |
| analyzeDocument | writes sectionMap | `#status IN (:draft, :active)` | ✅ |
| inviteReviewer | draft → active | `#status = :draft` | ✅ |
| createPublicSession | draft → active | `#status = :draft` | ✅ |
| createSelfSession | draft → active | `#status = :draft` | ✅ |
| extendDeadline | updates closeDate | `#status IN (:draft, :active)` | ✅ |
| processPulseCheck | writes hasPulseCheck | **NONE** | ⚠️ See F-06 |
| updateItem | updates draft fields | **NONE** | ⚠️ See F-01 |
| getUploadUrl | writes documentStatus | **NONE** | ⚠️ See F-07 |

### Session Status Transitions: `not_started → in_progress → completed/expired/cancelled/discarded`

| Lambda | Transition | ConditionExpression | Verdict |
|--------|-----------|-------------------|---------|
| chat | not_started → in_progress | `#status IN (:not_started, :in_progress)` | ✅ |
| chat | in_progress → completed | `#status IN (:not_started, :in_progress)` | ✅ |
| cancelSession | not_started/in_progress → cancelled | `#status IN (:not_started, :in_progress)` | ✅ |
| expireSessions | * → expired | `#status <> :completed AND #status <> :cancelled AND #status <> :discarded` | ✅ |
| closeItem | not_started → expired | `#status = :not_started` | ✅ |
| closeExpiredItems | * → expired | `#status <> :completed` | ✅ |
| expirePublicSession | not_started/in_progress → expired | **NONE** | 🔴 See F-02 |
| deleteSessionTranscript | * → discarded | **NONE** | 🔴 See F-03 |
| validateSession | discarded → not_started | `#status = :discarded` | ✅ |
| sendReminder | writes lastReminderSent | **NONE** (non-status field) | ✅ Acceptable |

---

## 2. Findings

### F-01 — updateItem: No ConditionExpression on DynamoDB write
- **Severity:** HIGH
- **File:** `lambdas/urgd-pulse-updateItem/index.mjs` (line ~230)
- **Description:** The `UpdateItemCommand` that writes item fields has no `ConditionExpression`. The Lambda does a read-then-check (`if (currentItem.status !== 'draft')`) but this is a TOCTOU race. Between the `GetItemCommand` and the `UpdateItemCommand`, another Lambda (e.g., `inviteReviewer`) could transition the item from `draft` to `active`, and the update would still succeed — writing to a locked item.
- **Impact:** An item that has been activated could have its name, description, or closeDate overwritten by a concurrent updateItem call.
- **Suggested Fix:** Add `ConditionExpression: '#status = :draft'` to the `UpdateItemCommand`:
  ```javascript
  ConditionExpression: '#status = :draft',
  ExpressionAttributeNames: { ...expressionNames, '#status': 'status' },
  ExpressionAttributeValues: { ...expressionValues, ':draft': { S: 'draft' } },
  ```

### F-02 — expirePublicSession: No ConditionExpression on status write
- **Severity:** CRITICAL
- **File:** `lambdas/urgd-pulse-expirePublicSession/index.mjs` (line ~72)
- **Description:** The `UpdateItemCommand` that sets `status = 'expired'` has **no ConditionExpression**. The Lambda does a read-then-check (`if (currentStatus !== 'not_started' && currentStatus !== 'in_progress')`) but this is a TOCTOU race. Between the `QueryCommand` and the `UpdateItemCommand`, the session could be completed by the chat Lambda, and this write would overwrite `completed` with `expired` — destroying a terminal state.
- **Impact:** A completed session could be silently overwritten to `expired`, losing the reviewer's feedback and corrupting the pulse check.
- **Suggested Fix:** Add a `ConditionExpression` to the `UpdateItemCommand`:
  ```javascript
  ConditionExpression: '#st IN (:not_started, :in_progress)',
  ExpressionAttributeValues: {
    ':now': { S: now },
    ':expired': { S: 'expired' },
    ':not_started': { S: 'not_started' },
    ':in_progress': { S: 'in_progress' },
  },
  ```

### F-03 — deleteSessionTranscript: No ConditionExpression on status write
- **Severity:** HIGH
- **File:** `lambdas/urgd-pulse-deleteSessionTranscript/index.mjs` (line ~76)
- **Description:** The `UpdateItemCommand` that sets `status = 'discarded'` has **no ConditionExpression**. The Lambda checks `if (session.status?.S === 'completed')` before writing, but this is a TOCTOU race. A session could complete between the read and the write, and the `discarded` status would overwrite `completed`.
- **Impact:** A completed session could be overwritten to `discarded`, losing the reviewer's feedback.
- **Suggested Fix:** Add a `ConditionExpression`:
  ```javascript
  ConditionExpression: '#status <> :completed AND #status <> :expired',
  ExpressionAttributeNames: { '#status': 'status' },
  ExpressionAttributeValues: {
    ':status': { S: 'discarded' },
    ':discardedAt': { S: new Date().toISOString() },
    ':completed': { S: 'completed' },
    ':expired': { S: 'expired' },
  },
  ```

### F-04 — decrementCounter: Read-then-write race condition
- **Severity:** MEDIUM
- **File:** `lambdas/shared/counters.mjs` (lines ~90–130)
- **Description:** The `decrementCounter` function reads the current counter value with `GetItemCommand`, checks if `currentCount < amount`, then writes with a separate `UpdateItemCommand` using `ADD :neg`. Between the read and the write, another Lambda could also decrement the same counter (e.g., two sessions expiring simultaneously for the same tenant), causing the counter to go negative despite the clamp-to-zero logic.
- **Impact:** Counter drift — the monthly usage counter could go negative. The clamp-to-zero path only fires if the read sees a low value, but two concurrent reads could both see `count=1` and both issue `ADD -1`, resulting in `count=-1`.
- **Suggested Fix:** Use a single atomic `UpdateItemCommand` with a `ConditionExpression` to prevent going below zero:
  ```javascript
  await dynamo.send(new UpdateItemCommand({
    TableName: tableName,
    Key: { tenantId: { S: tenantId } },
    UpdateExpression: 'ADD usageCounters.#counter.#count :neg',
    ConditionExpression: 'usageCounters.#counter.#count >= :amount',
    ExpressionAttributeNames: { '#counter': counterName, '#count': 'count' },
    ExpressionAttributeValues: {
      ':neg': { N: String(-amount) },
      ':amount': { N: String(amount) },
    },
  }))
  ```
  Catch `ConditionalCheckFailedException` and clamp to zero in the catch block.

### F-05 — cancelSession: sessionCount decrement without floor guard
- **Severity:** MEDIUM
- **File:** `lambdas/urgd-pulse-cancelSession/index.mjs` (line ~93)
- **Description:** The `sessionCount` decrement on the items table uses `ADD sessionCount :neg` with value `-1` but has no `ConditionExpression` to prevent the count from going below zero. If two cancellations race, or if the count is already 0 due to a prior deleteItem, the count could go negative.
- **Impact:** Negative `sessionCount` displayed in the UI. Cosmetic but confusing.
- **Suggested Fix:** Add a condition or use a SET expression with a floor:
  ```javascript
  ConditionExpression: 'sessionCount > :zero',
  ExpressionAttributeValues: {
    ':now': { S: new Date().toISOString() },
    ':neg': { N: '-1' },
    ':zero': { N: '0' },
  },
  ```

### F-06 — processPulseCheck: hasPulseCheck write without ConditionExpression
- **Severity:** LOW
- **File:** `lambdas/urgd-pulse-processPulseCheck/index.mjs` (line ~502)
- **Description:** The `UpdateItemCommand` that stamps `hasPulseCheck = true` on the item record has no `ConditionExpression`. This is a non-status field write (boolean flag + timestamp), so the risk is low — it's idempotent and only sets `true`. However, it could write to an item that has been deleted between the pulse check start and completion.
- **Impact:** Minimal — writing to a deleted item would recreate a partial record. The `.catch()` handler swallows errors gracefully.
- **Suggested Fix:** Add `ConditionExpression: 'attribute_exists(tenantId)'` to ensure the item still exists.

### F-07 — getUploadUrl: documentStatus write without ConditionExpression
- **Severity:** HIGH
- **File:** `lambdas/urgd-pulse-getUploadUrl/index.mjs` (line ~195)
- **Description:** The `UpdateItemCommand` that sets `documentStatus = 'scanning'` has no `ConditionExpression`. The Lambda checks `if (itemStatus !== 'draft')` before writing, but this is a TOCTOU race. Between the read and the write, the item could transition to `active` (via inviteReviewer), and the write would overwrite `documentStatus` on an active item.
- **Impact:** Could overwrite `documentStatus` on an active item, potentially resetting a `ready` status back to `scanning`.
- **Suggested Fix:** Add `ConditionExpression: '#status = :draft'`:
  ```javascript
  ConditionExpression: '#status = :draft',
  ExpressionAttributeNames: { '#status': 'status' },
  ```

### F-08 — generateRevision: No item status guard
- **Severity:** MEDIUM
- **File:** `lambdas/urgd-pulse-generateRevision/index.mjs` (line ~60)
- **Description:** The `generateRevision` Lambda checks that a pulse check exists and is `complete`, but does **not** verify the item status is `closed`. A revised item could have another revision generated. The downstream `processRevision` does guard with `ConditionExpression: '#status = :closed'`, so the revision would fail at step 7, but only after consuming Bedrock tokens and S3 writes.
- **Impact:** Wasted Bedrock invocation costs if a revision is triggered on an already-revised item. The processRevision guard prevents data corruption, but the work is wasted.
- **Suggested Fix:** Add an item status check in `generateRevision`:
  ```javascript
  const itemResult = await dynamo.send(new GetItemCommand({
    TableName: process.env.ITEMS_TABLE,
    Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
    ProjectionExpression: '#status',
    ExpressionAttributeNames: { '#status': 'status' },
  }))
  if (itemResult.Item?.status?.S !== 'closed') {
    return errorResponse(409, 'Item must be closed to generate a revision', {}, origin)
  }
  ```

### F-09 — generateRevision: Async invocation failure marks revision as failed without ConditionExpression
- **Severity:** LOW
- **File:** `lambdas/urgd-pulse-generateRevision/index.mjs` (line ~107)
- **Description:** When the async invocation of `processRevision` fails, the catch block marks the revision as `failed` using `UpdateItemCommand` without a `ConditionExpression`. This is acceptable because the revision was just created with `PutItemCommand` moments before, so no race is realistic. However, the `.catch(() => {})` swallows the error silently.
- **Impact:** Minimal — the revision record is brand new, so no concurrent mutation is possible.
- **Suggested Fix:** No change needed, but consider logging the swallowed error.

---

## 3. Race Conditions & Async Timing

### F-10 — Fire-and-forget Lambda invocations: Failure handling audit

| Caller | Target | Failure Handling | Verdict |
|--------|--------|-----------------|---------|
| chat | generateSessionSummary | try/catch, logs warning | ✅ |
| chat | generateReport | try/catch, logs warning | ✅ |
| expireSessions | generateReport | try/catch, logs warning | ✅ |
| expireSessions | runPulseCheck | try/catch, logs warning | ✅ |
| closeExpiredItems | generateReport | try/catch, logs warning | ✅ |
| closeExpiredItems | runPulseCheck | try/catch, logs error | ✅ |
| closeExpiredItems | sendPulseCheckReady | try/catch, logs error | ✅ |
| generateRevision | processRevision | try/catch, marks revision failed, returns 500 | ✅ |
| processRevision | sendRevisionReady | try/catch, logs warning | ✅ |
| runPulseCheck | processPulseCheck | **No try/catch** | ⚠️ See F-11 |
| validateSession | primeCacheWorker | try/catch, logs warning | ✅ |
| extractText | analyzeDocument | try/catch, logs warning | ✅ |
| extractText | renderPages | try/catch, logs warning | ✅ |
| updateItem | analyzeDocument | try/catch, logs warning | ✅ |
| createItem | analyzeDocument | try/catch, logs warning | ✅ |
| shieldCallback | analyzeDocument | try/catch, logs warning | ✅ |
| shieldCallback | extractText | try/catch, logs warning | ✅ |

### F-11 — runPulseCheck: Async invocation not wrapped in try/catch
- **Severity:** MEDIUM
- **File:** `lambdas/urgd-pulse-runPulseCheck/index.mjs` (line ~122)
- **Description:** The `InvokeCommand` for `processPulseCheck` is not wrapped in its own try/catch. If the invocation fails, the outer catch returns a generic 500 error, but the pulse check record has already been written with `status: 'generating'`. The record will be stuck in `generating` state forever with no retry mechanism.
- **Impact:** Orphaned `generating` pulse check record. The frontend will poll indefinitely until timeout.
- **Suggested Fix:** Wrap the invocation in try/catch and update the pulse check record to `failed` on invocation failure (same pattern as `generateRevision`).

### F-12 — Frontend optimistic updates: Missing rollback
- **Severity:** MEDIUM
- **File:** `apps/admin-ui/src/pages/InviteModal.tsx` (lines 174, 199, 295)
- **Description:** Three `queryClient.setQueryData` calls perform optimistic cache updates:
  1. **Line 174:** After invite success — sets new sessions in cache. This is safe because it's post-success, not pre-mutation.
  2. **Line 199:** After cancel success — sets session status to `cancelled`. Also post-success.
  3. **Line 295:** After expire public session — sets session status to `expired`. Also post-success.

  All three are **post-success** optimistic updates (the mutation has already succeeded), followed by `invalidateQueries` to refetch. This is the correct pattern — no rollback needed.
- **Impact:** None — these are not true optimistic updates (pre-mutation). They're cache priming after confirmed success.
- **Verdict:** ✅ No issue.

### F-13 — useItemForm: Cache update without rollback
- **Severity:** LOW
- **File:** `apps/admin-ui/src/hooks/useItemForm.ts` (lines 486, 518)
- **Description:** `queryClient.setQueryData(['item', targetItemId], { data: refreshed })` is called after a successful GET response (polling for document status). This is a cache update from a fresh server response, not an optimistic mutation. No rollback needed.
- **Verdict:** ✅ No issue.

---

## 4. CORS Preflight Coverage

### Methods requiring OPTIONS preflight (PATCH, PUT, DELETE):

| Resource | Method | OPTIONS Present | Verdict |
|----------|--------|----------------|---------|
| PulseManageSettingsResource | PUT (line 2853) | ✅ (line 2866) | ✅ |
| PulseManageAccountResource | DELETE (line 2900) | ✅ (line 2913) | ✅ |
| PulseManageItemResource | PUT (line 3747) | ✅ (line 3773) | ✅ |
| PulseManageItemResource | DELETE (line 3760) | ✅ (line 3773) | ✅ |
| PulseManageItemSessionResource | DELETE (line 5020) | ✅ (line 5033) | ✅ |
| PulseManageItemDeadlineResource | PUT (line 5067) | ✅ (line 5080) | ✅ |
| PulseManageItemSessionExpireResource | PUT (line 5156) | ✅ (line 5169) | ✅ |
| PulseManageItemCloseResource | PUT (line 5203) | ✅ (line 5216) | ✅ |
| PulseSessionSummaryResource | PATCH (line 6479) | ✅ (line 6492) | ✅ |
| PulseSessionTranscriptResource | DELETE (line 6526) | ✅ (line 6539) | ✅ |
| PulseManageItemDocumentResource | DELETE (line 6622) | ✅ (line 6635) | ✅ |
| PulseManageItemPulseCheckDecisionsResource | PUT (line 7501) | ✅ (line 7514) | ✅ |
| PulseAdminTenantIdResource | PATCH (line 8733) | ✅ (line 8746) | ✅ |

**CORS Verdict: All PATCH/PUT/DELETE endpoints have corresponding OPTIONS methods. No issues found.**

---

## 5. Guard Clauses on Closed/Revised Items

| Lambda | Operation | Guard Against Closed/Revised | Verdict |
|--------|-----------|------------------------------|---------|
| inviteReviewer | Create session | `if (itemStatus !== 'draft' && itemStatus !== 'active')` → 409 | ✅ |
| createPublicSession | Create session | `if (itemStatus !== 'draft' && itemStatus !== 'active')` → 409 | ✅ |
| createSelfSession | Create session | `if (itemStatus !== 'draft' && itemStatus !== 'active')` → 409 | ✅ |
| updateItem | Update item fields | `if (currentItem.status !== 'draft')` → 409 | ⚠️ Read-only guard (F-01) |
| extendDeadline | Extend closeDate | Read check + `ConditionExpression: '#status IN (:draft, :active)'` | ✅ |
| getUploadUrl | Upload document | `if (itemStatus !== 'draft')` → 409 | ⚠️ Read-only guard (F-07) |
| closeItem | Close item | `ConditionExpression: '#status IN (:draft, :active)'` | ✅ |
| generateRevision | Generate revision | Checks pulse check status only, not item status | ⚠️ See F-08 |
| runPulseCheck | Run pulse check | `if (itemStatus !== 'closed')` → 409 | ✅ |
| analyzeDocument | Write sectionMap | `ConditionExpression: '#status IN (:draft, :active)'` | ✅ |

---

## 6. Recently Modified Files — Targeted Audit

### `cancelSession/index.mjs` — Counter decrement after cancel
- **Session status guard:** ✅ `ConditionExpression: '#status IN (:not_started, :in_progress)'`
- **Counter decrement:** ⚠️ `decrementCounter` has read-then-write race (F-04)
- **sessionCount decrement:** ⚠️ No floor guard (F-05)
- **Overall:** Session transition is safe. Counter operations have minor race windows.

### `expireSessions/index.mjs` — Counter decrement per expired session
- **Session status guard:** ✅ `ConditionExpression: '#status <> :completed AND #status <> :cancelled AND #status <> :discarded'`
- **Counter decrement:** ⚠️ Same `decrementCounter` race (F-04). In a batch expire of many sessions for the same tenant, multiple decrements could race.
- **Overall:** Session transition is safe. Counter drift risk scales with batch size.

### `expirePublicSession/index.mjs` — Counter decrement
- **Session status guard:** 🔴 **No ConditionExpression** (F-02)
- **Counter decrement:** ⚠️ Same `decrementCounter` race (F-04)
- **Overall:** Critical — terminal state can be overwritten.

### `deleteItem/index.mjs` — Cascading counter decrements
- **Item deletion:** ✅ Uses `DeleteItemCommand` (not a status transition)
- **Counter decrements:** Uses `computeSessionDecrements` to exclude cancelled/discarded sessions — correct logic. But `decrementCounter` with `amount > 1` still has the read-then-write race (F-04).
- **Overall:** Logic is sound. Counter race is the same shared issue.

### `processRevision/index.mjs` — Async invocation of sendRevisionReady
- **Revision status guard:** ✅ `ConditionExpression: '#status = :generating'`
- **Item status guard:** ✅ `ConditionExpression: '#status = :closed'`
- **sendRevisionReady invocation:** ✅ Wrapped in try/catch, logs warning on failure
- **Feature flag check:** ✅ Checks `deliveryMode` before invoking
- **Overall:** Well-guarded. No issues.

### `generateRevision/index.mjs` — deliveryMode in response
- **Item status guard:** ⚠️ Missing (F-08)
- **Async invocation guard:** ✅ Marks revision as `failed` on invocation failure
- **deliveryMode:** ✅ Correctly resolved from SYSTEM record
- **Overall:** Missing item status check wastes Bedrock tokens on revised items.

### `getItems/index.mjs` — hasCompletedRevision query
- **Implementation:** ✅ Queries `REVISIONS_TABLE` itemId-index GSI with `Limit: 1`
- **Error handling:** ✅ Returns `false` on failure (fail-open)
- **Performance:** ✅ Only queries for closed/revised items
- **Overall:** Clean implementation. No issues.

---

## Priority Fix Order

1. **F-02** (CRITICAL) — `expirePublicSession` missing ConditionExpression → can overwrite completed sessions
2. **F-01** (HIGH) — `updateItem` missing ConditionExpression → TOCTOU race on draft check
3. **F-03** (HIGH) — `deleteSessionTranscript` missing ConditionExpression → can overwrite completed sessions
4. **F-07** (HIGH) — `getUploadUrl` missing ConditionExpression → can write to active items
5. **F-04** (MEDIUM) — `decrementCounter` read-then-write race → counter drift
6. **F-11** (MEDIUM) — `runPulseCheck` async invocation not guarded → orphaned generating records
7. **F-08** (MEDIUM) — `generateRevision` missing item status check → wasted Bedrock costs
8. **F-05** (MEDIUM) — `cancelSession` sessionCount decrement without floor → negative counts
