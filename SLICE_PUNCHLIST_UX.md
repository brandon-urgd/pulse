# Pulse — Punchlist Slice UX Specification

**Project:** Pulse
**Slice:** Punchlist (Tasks 31–38)
**Status:** UX SPECIFICATION
**Type:** UX Contract for Punchlist Build Phase
**Date:** March 21, 2026

**Companion documents:**
- `.kiro/specs/pulse/design.md` — architecture, data models, API surface, component inventory
- `.kiro/specs/pulse/requirements.md` — full requirements
- `.kiro/specs/pulse/tasks.md` — implementation tasks (tasks 31–38)
- `urgd_library/standards/ur gd Command Integration Standard.md` — report intake API contract

**Slice context:** The punchlist covers eight scoped additions to be implemented after S6 is complete. Each is a self-contained feature that improves UX completeness, safety, or polish without touching the core S0–S6 architecture. Tasks are grouped by feature area:

| Task | Feature | Apps Touched |
|------|---------|-------------|
| 31 | Session Preview Mode | admin-ui, session-ui, Lambda |
| 32 | Self-Review Sessions | admin-ui, session-ui, Lambda |
| 33 | Discarded Session Recovery | session-ui, Lambda |
| 34 | Mobile Viewport & PWA Feel | session-ui |
| 35 | Session UX Polish | session-ui, Lambda (system prompt) |
| 36 | Graceful Session Closing | session-ui, Lambda |
| 37 | Abuse / Bug Report / Contact Integration | admin-ui, session-ui, Lambda |
| 38 | Chat Bubble Min-Width Fix | session-ui |

**Design decisions that carry forward from S0–S6:**
- Inline styles only in session-ui (no CSS Modules)
- CSS Modules in admin-ui
- All user-facing strings in admin-ui sourced from `labels-registry.ts`
- Pulse sage accent (`#4a7c59`) used only for branding moments — never on buttons or links
- `prefers-reduced-motion` respected on all animations
- `aria-live="polite"` on all form errors; `role="alert"` + `aria-live="assertive"` on system errors
- Session-ui is mobile-first, functional at 375px width
- Admin-ui is desktop-first

---

## Table of Contents

1. [Punchlist Feature Summary](#1-punchlist-feature-summary)
2. [User Flows](#2-user-flows)
3. [Screen Inventory](#3-screen-inventory)
4. [Copy Decisions](#4-copy-decisions)
5. [Edge Cases & Error Handling](#5-edge-cases--error-handling)

---

## 1. Punchlist Feature Summary

### Included

| # | Feature | Description |
|---|---------|-------------|
| P1 | **Session Preview Mode** | Admins can preview the reviewer experience before sending invites. A "Preview" button in ItemDetail generates a short-lived preview session token and opens session-ui in a new tab. Preview sessions skip confidentiality, don't write transcripts, and never appear in session counts or reports. |
| P2 | **Self-Review Sessions** | Tenants can review their own items. "Review it yourself" button creates a session where the tenant is both owner and reviewer. No email, no pulse code — the Cognito JWT is the identity proof. Self-review sessions are flagged separately in reports. |
| P3 | **Discarded Session Recovery** | If a reviewer discards a session and later reopens the link, they get a second chance. `validateSession` re-issues a token, resets status to "not_started", and the session restarts clean. |
| P4 | **Mobile Viewport & PWA Feel** | Session-ui fills the screen like a native app on mobile. Viewport meta tags prevent zoom/bounce. PWA manifest enables "Add to Home Screen". Chat layout uses `100dvh`. |
| P5 | **Session UX Polish** | Small touches: confidentiality transition animation, "powered quietly by ur/gd" footer, agent identity label, reflection pauses in system prompt, warmer end-of-session copy. |
| P6 | **Graceful Session Closing** | State-based closing replaces pure time-based wind-down. Four states: `exploring → narrowing → closing → closed`. The grace window is turn-based — reviewers finish their thought before the session locks. |
| P7 | **Abuse / Bug Report / Contact** | Session-ui gets "Report abuse" and "Report a problem" links in the footer. Admin-ui gets a Support section in Settings. Both route through a thin Lambda proxy to the Command Integration intake API. |
| P8 | **Chat Bubble Min-Width Fix** | Short messages (2–4 words) no longer collapse into a tall narrow column. `minWidth: '80px'` on both bubble variants prevents orphaned single-word lines. |

### Excluded from Punchlist

| Feature | Reason |
|---------|--------|
| Streaming responses (token-by-token) | Separate future spec (`pulse-streaming`) — requires Lambda handler rewrite + API Gateway config change |
| Dynamic sections / companion model | Separate future spec (`pulse-dynamic-sections`) |
| Coverage routing | Separate future spec (`pulse-coverage-routing`) |
| Example session onboarding | Separate future spec (`pulse-example-session`) |
| Any changes to S0–S6 core flows | Punchlist is additive only — no regressions to existing behavior |

### API Endpoints Added

| Method | Path | Lambda | Auth | Purpose |
|--------|------|--------|------|---------|
| `GET` | `/api/manage/items/{itemId}/preview-session` | `urgd-pulse-previewSession` | Cognito JWT | Generate preview session token |
| `POST` | `/api/manage/items/{itemId}/self-review` | `urgd-pulse-createSelfSession` | Cognito JWT | Create self-review session |
| `POST` | `/api/session/{sessionId}/report` | `urgd-pulse-submitReport` | Session token | Submit abuse/bug report from session-ui |
| `POST` | `/api/manage/report` | `urgd-pulse-submitReport` | Cognito JWT | Submit support/contact from admin-ui |

### Feature Flags

| Flag | Default | Scope | Effect When Disabled |
|------|---------|-------|---------------------|
| `sessionTimeLengthRecommendation` | `true` (all tiers) | P1 | Recommended session time not shown after upload |


---

## 2. User Flows

### Flow 1: Session Preview (Admin)

**Persona:** Tenant who wants to see the reviewer experience before sending invites.
**Entry point:** ItemDetail page, edit mode (item exists, not create mode).
**Precondition:** Item has at least some content (paste or uploaded document).

| Step | User Action | System Response | Screen State |
|------|-------------|-----------------|--------------|
| 1 | Opens an item in edit mode | ItemDetail renders. "Preview" button visible in the session invitation section. | ItemDetail — edit mode. |
| 2 | Clicks "Preview" | Button enters loading state (disabled, spinner). `GET /api/manage/items/{itemId}/preview-session` fires. | Button: "Opening preview…" |
| 3 | Lambda returns `{ previewUrl }` | New tab opens at `previewUrl` (`/s/?code={pulseCode}&preview=true`). Button returns to idle. | New tab: session-ui validate screen. Admin tab: button re-enabled. |
| 4 | In new tab: session-ui detects `?preview=true` | Non-dismissible preview banner renders at top: "This is a preview. Responses are not saved." Confidentiality screen is skipped. | Session-ui: preview banner + chat loads directly. |
| 5 | Tenant chats with the agent | Bedrock is called normally. Responses render. No transcript written to DynamoDB. Session state not updated. | Chat works as normal. No progress persisted. |
| 6 | Tenant closes the tab | Preview session expires after 15 minutes. No data remains. | — |

**Error states:**
- Preview endpoint fails (500): inline error below "Preview" button — "Preview couldn't be started. Try again."
- Preview tab blocked by browser popup blocker: inline note — "Preview opened in a new tab. If it didn't open, check your popup settings."

---

### Flow 2: Session Preview — Recommended Time Length

**Persona:** Tenant who just uploaded a document and sees a time recommendation.
**Entry point:** ItemDetail, after `documentStatus` transitions to "ready".
**Precondition:** `sessionTimeLengthRecommendation` feature flag is `true`.

| Step | User Action | System Response | Screen State |
|------|-------------|-----------------|--------------|
| 1 | Document finishes processing | `documentStatus` → "ready". Recommendation panel appears below the file status row. | Recommendation panel: "Suggested session length: 20 min — based on your document length." |
| 2 | Tenant accepts recommendation | Clicks "Use 20 min". `sessionTimeLimitMinutes` saved to item. Panel dismisses. | Item updated. Panel gone. |
| 3 | Tenant overrides | Clicks "Change". Inline number input appears (5–60 min, respects tier ceiling). | Input field with current value. |
| 4 | Tenant enters custom value and confirms | Saves custom `sessionTimeLimitMinutes`. Panel dismisses. | Item updated. |

---

### Flow 3: Self-Review Session

**Persona:** Tenant who wants to give themselves feedback on their own item.
**Entry point:** ItemDetail page, draft or active item.

| Step | User Action | System Response | Screen State |
|------|-------------|-----------------|--------------|
| 1 | Sees "Review it yourself" button | Button visible for draft and active items. | ItemDetail — session section. |
| 2 | Clicks "Review it yourself" | Button enters loading state. `POST /api/manage/items/{itemId}/self-review` fires. | Button: "Starting…" |
| 3 | Lambda returns `{ sessionId, sessionUrl }` | New tab opens at `sessionUrl`. Button returns to idle. | New tab: session-ui confidentiality screen. |
| 4 | Tenant accepts confidentiality | Proceeds to chat. Session behaves identically to a reviewer session. | Chat screen. |
| 5 | Session completes | Report generated with `isSelfReview: true`. Appears in session list as "You" with "Self-review" badge. | ItemDetail session list updated. |

**Session list display for self-review:**
- Masked email column shows "You" instead of `j***@example.com`
- Status badge shows "Self-review" (distinct from status badges)
- All other session list behavior identical

---

### Flow 4: Discarded Session Recovery

**Persona:** Reviewer who discarded a session and reopened the link.
**Entry point:** Original invitation link or pulse code.

| Step | User Action | System Response | Screen State |
|------|-------------|-----------------|--------------|
| 1 | Reopens invitation link | `validateSession` called. Session status is "discarded". | — |
| 2 | `validateSession` detects discarded status | Re-issues session token. Resets status to "not_started". Clears `discardedAt`. | — |
| 3 | Reviewer lands on email validation screen | Normal validate flow. Enters email. | SessionValidate screen. |
| 4 | Proceeds through confidentiality → chat | `__session_start__` sent. Fresh transcript begins. No reference to previous attempt. | Chat screen — clean start. |

**Note:** The old transcript was already deleted by `deleteSessionTranscript`. This is a clean restart, not a resume. The reviewer sees no indication that a previous session existed.

---

### Flow 5: Mobile Viewport & PWA Install

**Persona:** Reviewer on a mobile device.
**Entry point:** Session link opened on iOS or Android.

| Step | User Action | System Response | Screen State |
|------|-------------|-----------------|--------------|
| 1 | Opens session link on mobile | Viewport meta prevents zoom. `html, body` locked to `100dvh`. No horizontal scroll. | Session-ui fills screen edge-to-edge. |
| 2 | Navigates through validate → confidentiality → chat | Each screen fills the viewport. Input bar stays anchored at bottom when keyboard opens. | Native-app feel throughout. |
| 3 | (iOS) Taps Share → "Add to Home Screen" | PWA manifest provides app name "Pulse", sage theme color, standalone display mode. | App icon added to home screen. |
| 4 | Opens from home screen | Launches in standalone mode (no browser chrome). | Full-screen session experience. |

---

### Flow 6: Confidentiality Transition (UX Polish)

**Persona:** Reviewer accepting confidentiality.
**Entry point:** Confidentiality screen, clicks "I Accept".

| Step | User Action | System Response | Screen State |
|------|-------------|-----------------|--------------|
| 1 | Clicks "I Accept" | API call fires. Brief transition state renders: "Let's get your pulse…" with subtle fade. | Transition overlay — sage-tinted, centered text. |
| 2 | API returns success | Fade completes. Navigation to chat. | Chat screen. |
| 3 | `prefers-reduced-motion: reduce` | Transition is instant — no fade, no delay. Navigation fires immediately after API success. | Chat screen (no animation). |

---

### Flow 7: Graceful Session Closing

**Persona:** Reviewer in an active session approaching the time limit.
**Entry point:** Chat screen, session in progress.

| Step | User Action | System Response | Screen State |
|------|-------------|-----------------|--------------|
| 1 | Session at ~70% time elapsed | `closingState` transitions to `narrowing`. Model begins focusing topics, no new branches. Time display visible. | Chat — input active, time display normal. |
| 2 | Model sends closing question | `closingState` transitions to `closing`. Time display changes to "Wrapping up". PulseLine animation slows. | Chat — input active (grace window). "Wrapping up" replaces countdown. |
| 3 | Reviewer sends 1–2 more messages | Grace window: up to 2 reviewer messages + 1 final agent reply allowed. | Chat — input active. |
| 4 | Agent sends final reply | `closingState` transitions to `closed`. Input locks. Session transitions to "completed". Summary generation fires. | Chat — input disabled. "Session complete" caption. Completion card appears. |
| 5 | Reviewer is mid-thought when closing question arrives | Reviewer sends their response. Agent acknowledges and closes warmly. Session does not lock until after agent's final reply. | Grace window honored. |

**Closing state UI mapping:**

| `closingState` | Time Display | Input | PulseLine |
|---------------|-------------|-------|-----------|
| `exploring` | `{M}:{SS} left` | Active | Normal animation |
| `narrowing` | `{M}:{SS} left` | Active | Normal animation |
| `closing` | "Wrapping up" | Active (grace window) | Slowed animation (4s) |
| `closed` | Hidden | Disabled | Fully filled |

---

### Flow 8: Report Abuse / Bug (Session-UI)

**Persona:** Reviewer who encounters a problem or inappropriate content during a session.
**Entry point:** Session footer (visible on validate, confidentiality, and summary screens).

| Step | User Action | System Response | Screen State |
|------|-------------|-----------------|--------------|
| 1 | Taps "Report abuse" or "Report a problem" in footer | `ReportSheet` slides up from bottom (mobile) or appears as centered card (desktop). | ReportSheet open. |
| 2 | Types description in textarea | Character count updates. | Textarea with text. |
| 3 | Taps "Submit" | `POST /api/session/{sessionId}/report` fires. Button enters loading state. | Button: "Submitting…" |
| 4 | Success | Brief confirmation: "Thanks, we got it." Sheet auto-closes after 2 seconds. | Sheet closes. Footer visible again. |
| 5 | Error | Inline error: "Couldn't send your report. Try again." Retry button. | Sheet stays open. |

**Footer visibility rules:**
- Visible on: SessionValidate, Confidentiality, SessionSummary
- Hidden during: active Chat (footer hidden per task 35.2)
- Footer links: "Report abuse" | "Report a problem" | "powered quietly by ur/gd"

---

### Flow 9: Contact / Bug Report (Admin-UI)

**Persona:** Tenant who wants to report a bug, request a feature, or ask a question.
**Entry point:** Settings page → Support section.

| Step | User Action | System Response | Screen State |
|------|-------------|-----------------|--------------|
| 1 | Navigates to Settings | Support section visible with three links: "Contact support", "Report a bug", "Request a feature". Privacy section with "Privacy question" link. | Settings page. |
| 2 | Clicks "Report a bug" | `ReportModal` opens. Type pre-selected as "Bug report". | ReportModal open. |
| 3 | Fills in message (required) and optionally name/email | Character count updates. Name/email pre-filled from account if available. | Form fields populated. |
| 4 | Clicks "Submit" | `POST /api/manage/report` fires. Button enters loading state. | Button: "Submitting…" |
| 5 | Success | Confirmation message in modal: "Your report has been sent." Modal closes after 2 seconds. | Modal closes. Settings page. |
| 6 | Error | Inline error: "Couldn't send your report. Try again." | Modal stays open. |

---

### Flow 10: Chat Bubble Min-Width (Visual Fix)

This is a visual fix, not a user flow. The behavior change:

**Before:** A message like "Got it." renders as a tall narrow bubble — "Got" on one line, "it." on the next.

**After:** `minWidth: '80px'` on both bubble variants. "Got it." renders as a single clean line. Messages long enough to wrap naturally are unaffected.

**Verification messages to test:**
- "Yes." → single line
- "No." → single line
- "Got it." → single line
- "No this that's about it" → single line or two balanced lines
- "I think this is good" → single line or two balanced lines
- "It all needs to be revised now" → wraps naturally, no orphan


---

## 3. Screen Inventory

### 3.1 ItemDetail — Preview Button (admin-ui)

| Property | Detail |
|----------|--------|
| **Screen** | ItemDetail (edit mode) |
| **Route** | `/admin/items/{itemId}` |
| **New element** | "Preview" button in session invitation section |
| **API Endpoint** | `GET /api/manage/items/{itemId}/preview-session` |
| **States** | Idle: "Preview" button enabled. Loading: "Opening preview…" + disabled. Error: inline error below button. |
| **Visibility** | Edit mode only (not create mode). Visible regardless of item status. |

### 3.2 ItemDetail — Recommended Session Time (admin-ui)

| Property | Detail |
|----------|--------|
| **Screen** | ItemDetail (edit mode) |
| **Route** | `/admin/items/{itemId}` |
| **New element** | Recommendation panel below file status row |
| **API Endpoint** | None (recommendation computed by `extractText` Lambda, stored on item record) |
| **States** | Hidden: no document or `sessionTimeLengthRecommendation` flag off. Visible: after `documentStatus: "ready"`. Accepted: panel dismisses. Override: inline number input. |
| **Feature flag** | `sessionTimeLengthRecommendation` (default: true) |

### 3.3 ItemDetail — "Review it yourself" Button (admin-ui)

| Property | Detail |
|----------|--------|
| **Screen** | ItemDetail (edit mode) |
| **Route** | `/admin/items/{itemId}` |
| **New element** | "Review it yourself" button in session invitation section |
| **API Endpoint** | `POST /api/manage/items/{itemId}/self-review` |
| **States** | Idle: button enabled. Loading: "Starting…" + disabled. Error: inline error. |
| **Visibility** | Draft and active items only. |

### 3.4 ItemDetail — Session List Self-Review Badge (admin-ui)

| Property | Detail |
|----------|--------|
| **Screen** | ItemDetail session list |
| **New element** | "Self-review" badge on self-review sessions; "You" in masked email column |
| **API Endpoint** | `GET /api/manage/items/{itemId}/sessions` (existing, `isSelfReview` flag in response) |
| **States** | Normal session list behavior. Self-review rows have distinct badge. |

### 3.5 Session-UI — Preview Banner

| Property | Detail |
|----------|--------|
| **Screen** | Chat (preview mode) |
| **Route** | `/s/:sessionId/chat?preview=true` |
| **New element** | Non-dismissible banner at top of chat |
| **Trigger** | `?preview=true` query param detected |
| **Style** | `--color-accent-pulse-subtle` background, small text, full-width, not dismissible |
| **States** | Always visible during preview session. |

### 3.6 Session-UI — ReportSheet

| Property | Detail |
|----------|--------|
| **Screen** | Overlay (bottom sheet on mobile, centered card on desktop) |
| **Trigger** | "Report abuse" or "Report a problem" footer links |
| **API Endpoint** | `POST /api/session/{sessionId}/report` |
| **Components** | Textarea (`aria-label="Describe the issue"`), submit button, inline error, confirmation message |
| **States** | Idle: empty textarea. Loading: "Submitting…" button. Success: "Thanks, we got it." (auto-close 2s). Error: inline error + retry. |
| **Accessibility** | `role="dialog"`, `aria-modal="true"`, focus trapped, close on Escape |
| **Motion** | Slides up from bottom on mobile. `prefers-reduced-motion`: no animation, appears instantly. |

### 3.7 Session-UI — Footer

| Property | Detail |
|----------|--------|
| **Screen** | SessionValidate, Confidentiality, SessionSummary |
| **New element** | Footer with "Report abuse", "Report a problem", "powered quietly by ur/gd" |
| **Style** | `#555` text, small font, subtle — not loud |
| **Visibility** | Visible on validate, confidentiality, summary. Hidden during active chat. |

### 3.8 Session-UI — Confidentiality Transition

| Property | Detail |
|----------|--------|
| **Screen** | Confidentiality → Chat transition |
| **New element** | Brief transition state after "I Accept" |
| **Copy** | "Let's get your pulse…" |
| **Style** | Sage-tinted background, centered text, subtle fade |
| **Duration** | ~400ms fade, fires after API success |
| **Motion** | `prefers-reduced-motion`: instant navigation, no fade |

### 3.9 Session-UI — Agent Identity Label

| Property | Detail |
|----------|--------|
| **Screen** | Chat |
| **New element** | Small "Pulse" label beside PulseDot on agent message bubbles |
| **Style** | Subtle, small font — builds relationship without breaking minimalism |
| **Accessibility** | `aria-hidden="true"` (decorative) |

### 3.10 Session-UI — "Powered quietly by ur/gd" Footer

| Property | Detail |
|----------|--------|
| **Screen** | SessionValidate, Confidentiality, SessionSummary |
| **New element** | Footer text |
| **Copy** | "powered quietly by ur/gd" |
| **Style** | `#555`, small font, bottom of screen |
| **Visibility** | Hidden during active chat |

### 3.11 Admin-UI — Settings Support Section

| Property | Detail |
|----------|--------|
| **Screen** | Settings |
| **Route** | `/admin/settings` |
| **New element** | "Support" section with three links; "Privacy" section with one link |
| **Links** | "Contact support" → `ReportModal (general-inquiry)`, "Report a bug" → `ReportModal (bug-report)`, "Request a feature" → `ReportModal (feature-request)`, "Privacy question" → `ReportModal (privacy-question)` |

### 3.12 Admin-UI — ReportModal

| Property | Detail |
|----------|--------|
| **Screen** | Modal overlay |
| **Trigger** | Support/Privacy links in Settings |
| **API Endpoint** | `POST /api/manage/report` |
| **Components** | Type selector (pre-selected, changeable), message textarea (required, ≤ 5000 chars), optional name + email (pre-filled from account), submit button |
| **States** | Idle: form ready. Loading: "Submitting…" button. Success: "Your report has been sent." (auto-close 2s). Error: inline error + retry. |
| **Accessibility** | `role="dialog"`, `aria-modal="true"`, focus trapped, close on Escape |
| **Strings** | All from labels-registry |


---

## 4. Copy Decisions

### P1 — Session Preview

| Context | Copy |
|---------|------|
| Preview button (idle) | "Preview" |
| Preview button (loading) | "Opening preview…" |
| Preview button error | "Preview couldn't be started. Try again." |
| Popup blocked notice | "Preview opened in a new tab. If it didn't open, check your popup settings." |
| Preview banner (session-ui) | "This is a preview. Responses are not saved." |
| Recommended time panel | "Suggested session length: {N} min — based on your document length." |
| Accept recommendation button | "Use {N} min" |
| Override recommendation link | "Change" |
| Override input label | "Session length (minutes)" |
| Override confirm button | "Save" |

### P2 — Self-Review Sessions

| Context | Copy |
|---------|------|
| Button (idle) | "Review it yourself" |
| Button (loading) | "Starting…" |
| Button error | "Couldn't start your review. Try again." |
| Session list — masked email column | "You" |
| Session list — type badge | "Self-review" |
| Tooltip on button | "Give yourself feedback on this item. Your session won't count toward reviewer limits." |

### P3 — Discarded Session Recovery

No new copy. The recovered session flows through the existing validate → confidentiality → chat screens with no indication of the previous attempt. The reviewer sees a clean start.

### P4 — Mobile Viewport & PWA

| Context | Copy |
|---------|------|
| PWA app name (manifest) | "Pulse" |
| PWA short name | "Pulse" |
| PWA description | "Guided feedback sessions by ur/gd Studios" |

### P5 — Session UX Polish

| Context | Copy |
|---------|------|
| Confidentiality transition | "Let's get your pulse…" |
| Footer — powered by | "powered quietly by ur/gd" |
| Footer — report abuse link | "Report abuse" |
| Footer — report problem link | "Report a problem" |
| Agent identity label (beside PulseDot) | "Pulse" |
| Completion card (updated) | "Thanks — your feedback has been captured." |
| Completion card subtext | "Your responses have been shared with {Tenant Name}." |

**Note on completion card:** Previous copy was "Your feedback has been shared." The updated copy adds warmth ("Thanks —") and feels earned rather than transactional. Keep it grounded — not effusive.

### P6 — Graceful Session Closing

| Context | Copy |
|---------|------|
| Time display — exploring/narrowing | `{M}:{SS} left` |
| Time display — closing (grace window) | "Wrapping up" |
| Time display — closed | (hidden) |
| Input placeholder — closing | "Your message…" (unchanged) |
| Input placeholder — closed | "Session complete" |
| "Session complete" caption | "Session complete" |

**System prompt additions (closing states):**
- Entering `narrowing`: model should naturally begin focusing topics. No explicit announcement to the reviewer. The model's language shifts — fewer new branches, more depth on current topics.
- Entering `closing`: model sends a genuine final question. Not a formality. Something the reviewer actually wants to answer.
- Final reply (after grace window): warm acknowledgment. Not a new question. Something like: "That's really helpful — thank you for taking the time." The reviewer should feel heard, not processed.
- Reflection pause prompts (occasional, not every exchange): "Take a moment before answering." or "What's your gut reaction to that?" — signals that thoughtful answers are valued.

### P7 — Abuse / Bug Report / Contact

**Session-UI ReportSheet:**

| Context | Copy |
|---------|------|
| Sheet title — abuse | "Report abuse" |
| Sheet title — problem | "Report a problem" |
| Textarea placeholder — abuse | "Describe what happened. Include as much detail as you can." |
| Textarea placeholder — problem | "Describe the issue. What were you doing when it happened?" |
| Submit button (idle) | "Submit" |
| Submit button (loading) | "Submitting…" |
| Success message | "Thanks, we got it." |
| Error message | "Couldn't send your report. Try again." |
| Retry button | "Try again" |
| Close button aria-label | "Close" |

**Admin-UI ReportModal:**

| Context | Copy |
|---------|------|
| Modal title — general-inquiry | "Contact support" |
| Modal title — bug-report | "Report a bug" |
| Modal title — feature-request | "Request a feature" |
| Modal title — privacy-question | "Privacy question" |
| Type selector label | "Type" |
| Message field label | "Message" |
| Message placeholder | "Describe your issue or question." |
| Name field label | "Your name (optional)" |
| Email field label | "Your email (optional)" |
| Email helper text | "We'll use this to follow up if needed." |
| Submit button (idle) | "Submit" |
| Submit button (loading) | "Submitting…" |
| Success message | "Your report has been sent." |
| Error message | "Couldn't send your report. Try again." |
| Character limit warning (> 90%) | "{remaining} characters remaining" |
| Character limit exceeded | "Message must be 5,000 characters or fewer" |

**Settings page — Support section:**

| Context | Copy |
|---------|------|
| Section heading | "Support" |
| Link 1 | "Contact support" |
| Link 2 | "Report a bug" |
| Link 3 | "Request a feature" |
| Privacy section heading | "Privacy" |
| Privacy link | "Privacy question" |

### P8 — Chat Bubble Min-Width

No copy changes. Visual fix only.


---

## 5. Edge Cases & Error Handling

### P1 — Session Preview

| Scenario | Behavior |
|----------|----------|
| Preview endpoint returns 500 | Inline error below "Preview" button. Button re-enabled. No new tab opened. |
| Browser blocks popup | Button returns to idle. Inline note about popup settings appears below button. |
| Tenant clicks "Preview" twice quickly | Button disabled during first request. Second click ignored. |
| Preview session token expires (15 min) | Session-ui shows "This preview has expired." with a link back to admin. No error state — expected behavior. |
| Item has no content (no document, no paste) | "Preview" button still enabled. Agent will have no document context — this is acceptable for previewing the session flow. |
| `sessionTimeLengthRecommendation` flag is false | Recommendation panel never renders. No UI change otherwise. |
| Recommended time exceeds tier ceiling | Recommendation is capped at the tier's `sessionTimeLimitMinutes` ceiling before display. Never shows a value the tenant can't use. |
| Tenant enters 0 or negative value in override | Input validation: minimum 5 minutes. Error: "Minimum session length is 5 minutes." |
| Tenant enters value above tier ceiling | Input validation: maximum is tier ceiling. Error: "Maximum session length for your plan is {N} minutes." |

### P2 — Self-Review Sessions

| Scenario | Behavior |
|----------|----------|
| Tenant clicks "Review it yourself" on a closed item | Button not visible for closed items. No action possible. |
| Self-review endpoint returns 500 | Inline error below button. Button re-enabled. |
| Tenant already has a self-review session in progress | Button still enabled. A second self-review session is created (not idempotent). Both appear in session list. |
| Self-review session counts toward `maxSessionsPerItem` | If at limit, endpoint returns 403. Inline error: "You've reached the session limit for this item." |
| Self-review report in pulse check | `isSelfReview: true` flag on report. Pulse check consolidation can optionally separate self-review from external feedback. No UI change in punchlist — this is a data flag for future use. |

### P3 — Discarded Session Recovery

| Scenario | Behavior |
|----------|----------|
| Reviewer reopens link for an expired session | `validateSession` still returns 410 for expired sessions. Recovery only applies to "discarded" status. |
| Reviewer reopens link for a completed session | `validateSession` returns 409 (already completed). Session-ui shows "This session is already complete." with link to summary. |
| Reviewer reopens link for an active (in-progress) session | Normal resume flow — `__session_resume__` sent. No recovery needed. |
| `validateSession` fails during recovery (500) | Session-ui shows generic error: "Something went wrong. Try your link again." |

### P4 — Mobile Viewport & PWA

| Scenario | Behavior |
|----------|----------|
| iOS keyboard opens during chat | Input bar stays anchored at bottom. Chat scroll area adjusts. No viewport bounce. |
| Android keyboard opens during chat | Same behavior. `100dvh` + `touch-action: pan-y` on scroll area handles this. |
| Horizontal swipe gesture | `overflow: hidden` on body prevents horizontal scroll. Swipe does nothing. |
| PWA installed, session link opened from home screen | Launches in standalone mode. Session flows normally. |
| Browser doesn't support PWA manifest | Graceful degradation — normal browser tab. No error. |

### P5 — Session UX Polish

| Scenario | Behavior |
|----------|----------|
| `prefers-reduced-motion: reduce` — confidentiality transition | Transition state skipped entirely. Navigation fires immediately after API success. |
| `prefers-reduced-motion: reduce` — all other animations | All existing animation guards already in place from S4. No new animations added without motion guards. |
| Agent identity label ("Pulse") — screen reader | `aria-hidden="true"`. Screen readers skip it. The agent's messages are already announced via `aria-live="polite"` on the chat area. |
| Reflection pause prompts — reviewer ignores them | Normal conversation continues. The pause prompt is a soft signal in the system prompt, not a UI element. |

### P6 — Graceful Session Closing

| Scenario | Behavior |
|----------|----------|
| Reviewer sends message while in `closing` state | Grace window: up to 2 reviewer messages accepted. Third message attempt: input is disabled. |
| Agent fails to send final reply (Bedrock error) | System error bubble: "Something went wrong. Try refreshing." Session remains in `closing` state. Grace window preserved. |
| Session resumes (page reload) in `closing` state | `getSessionState` returns `closingState: "closing"`. Frontend renders "Wrapping up" time display. Input active (grace window). |
| Session resumes in `closed` state | Input disabled. "Session complete" caption. Completion card shown. |
| Time runs out before `closing` state is reached | Existing time-based wind-down signals (`windingDown: "true"` at 80%, `windingDown: "final"` at 95%) still fire. The state machine handles closure from there. The hard lock at 95% is removed — `closed` state handles it instead. |
| `closingState` field missing on old sessions | Treated as `exploring`. No regression. |

### P7 — Abuse / Bug Report / Contact

| Scenario | Behavior |
|----------|----------|
| Reviewer submits empty textarea | Client-side validation: "Please describe the issue." Submit button disabled until textarea has content. |
| Message exceeds 5000 chars | Character counter turns warning color. Submit blocked. Error: "Message must be 5,000 characters or fewer." |
| `submitReport` Lambda returns 400 | Inline error in sheet/modal: "Couldn't send your report. Try again." |
| `submitReport` Lambda returns 429 (rate limit) | Inline error: "Too many reports submitted. Please wait a moment and try again." |
| `submitReport` Lambda returns 502 (upstream Command error) | Inline error: "Couldn't send your report. Try again." (same as 400 — user doesn't need to know about upstream) |
| Network error | Inline error: "Couldn't reach the server. Check your connection and try again." |
| Admin-UI: name/email fields not pre-filled | Fields render empty. Both are optional. No error. |
| Admin-UI: tenant changes pre-filled email | Allowed. The email in the payload is what gets sent. |
| Session-UI: report submitted from summary screen | `sessionId` from URL param used in API path. Works normally. |
| Session-UI: report submitted from validate screen | Session token not yet issued. `sessionId` from URL param used. `sessionAuth` authorizer validates the session exists (not necessarily authenticated). |

**Note on session-ui auth for reports:** The `POST /api/session/{sessionId}/report` route uses `sessionAuth`. On the validate screen, the reviewer doesn't have a session token yet. Two options: (1) make the report endpoint public (no auth) with rate limiting, or (2) use a separate unauthenticated report endpoint for pre-session reports. **Decision: make `/api/session/{sessionId}/report` require a valid session token.** Reports from the validate screen are not supported — the footer on the validate screen only shows "powered quietly by ur/gd" and the report links appear after the session token is issued (confidentiality screen onward). Update footer visibility rule: report links visible on confidentiality and summary screens only (not validate).

### P8 — Chat Bubble Min-Width

| Scenario | Behavior |
|----------|----------|
| Message is exactly 1 word | `minWidth: '80px'` prevents collapse. Single word renders on one line with padding. |
| Message is 2–4 words | Renders as single line or two balanced lines. No orphaned single-word line. |
| Message is long (wraps naturally) | `minWidth` has no effect. `maxWidth` still controls wrapping. Existing behavior unchanged. |
| Message contains a very long single word (URL, etc.) | `overflow-wrap: break-word` (already in place) handles this. `minWidth` doesn't interfere. |
| 375px viewport | All bubble sizes tested at 375px. `minWidth: '80px'` is safe — narrower than any two-word phrase at the current font size. |

---

> **--- SLICE_PUNCHLIST_UX.md generation complete. All sections filled. Review before proceeding to the punchlist build phase. ---**
