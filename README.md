# Pulse

AI-guided feedback platform — by ur/gd Studios

Pulse pairs human reviewers with an AI conversation agent to extract structured, actionable feedback on documents, images, and creative work. Tenants upload content, invite reviewers, and receive synthesized insights through Pulse Checks — AI-generated theme analysis with proposed revisions.

## Architecture

**Frontend:** Two React 19 + Vite + TypeScript apps — `admin-ui` (tenant-facing, 13 pages, 17 components) and `session-ui` (reviewer-facing, 22 pages/components). S3 + CloudFront hosting, WAF-protected via Shield, Cognito-authenticated. React Query, Zod validation, CSS modules with design tokens.

**Backend:** 64 Lambda functions (Node.js 22.x, ES modules), API Gateway REST API (51 routes), dual authorizer system (Cognito JWT for admin routes, session token for reviewer routes). Bedrock Claude for AI conversation, Pulse Check synthesis, and document revision.

**Data:** 7 DynamoDB tables (PAY_PER_REQUEST, PITR enabled), S3 for document/image storage with Shield quarantine scanning.

**Infrastructure:** Single CloudFormation template (9,400 lines), 3 environments (dev/staging/prod), EventBridge schedulers, 9 CloudWatch alarms, X-Ray tracing, SNS alerting.

## Structure

```
pulse/
├── .github/workflows/
│   └── deploy-pulse.yml              # CI/CD — auto-deploy dev on push, manual staging/prod
├── apps/
│   ├── admin-ui/                      # Tenant dashboard (React 19 + Vite + TypeScript)
│   ├── session-ui/                    # Reviewer conversation UI
│   └── shared/                        # Shared types, constants, feature helpers
├── cloudformation/
│   └── pulse-stack.yaml               # All infrastructure (9,400 lines)
├── lambdas/
│   ├── shared/                        # utils.mjs, features.mjs, tiers.mjs, counters.mjs
│   └── urgd-pulse-{function}/         # 64 individual Lambda functions
├── scripts/
│   ├── build-lambdas.sh               # Package and upload Lambda ZIPs
│   ├── deploy-frontend.sh             # S3 sync with cache headers
│   ├── smoke.sh                       # Post-deploy smoke tests (64 Lambda coverage)
│   └── register-with-shield.py        # Shield WAF integration
└── tests/
    └── property/                      # Property-based tests (fast-check)
```

## Key Features

- AI conversation agent (Bedrock Claude) guides reviewers through structured feedback sessions
- Document and image support with automatic text extraction and section analysis
- Pulse Checks — AI-synthesized theme analysis across multiple reviewer sessions
- Proposed revisions with accept/adjust/dismiss decision workflow
- AI-powered document revision based on tenant decisions and adjustment notes
- Tiered feature flag system (free/individual/pro/enterprise) with runtime resolution
- Public session links with QR codes for anonymous feedback collection
- Session summaries, reports, and PDF export
- Stripe billing integration with usage-based counters
- Async revision delivery with email notification when revisions complete
- Annotated change lists for PDF/DOCX revisions (location-specific edits instead of full rewrite)
- Counter decrement accuracy — cancelled, expired, and deleted sessions/items subtracted from monthly usage counters

## Lambda Functions (64)

| Category | Functions |
|---|---|
| Auth | cognitoAuth, sessionAuth, register, createTenant, validateSession, acceptConfidentiality |
| Items | getItems, createItem, getItem, updateItem, deleteItem, closeItem |
| Documents | getUploadUrl, extractText, getDocumentUrl, removeDocument, analyzeDocument, renderPages |
| Sessions | inviteReviewer, getItemSessions, cancelSession, resendInvite, extendDeadline, sendReminder, expireSessions, createPublicSession, getPublicSessionQr, expirePublicSession, previewSession, createSelfSession |
| Conversation | chat, getSessionState, getSessionSummary, generateSessionSummary, deleteSessionTranscript, getSessionFile, emailSessionSummary, submitReport |
| Pulse Check | runPulseCheck, processPulseCheck, getPulseCheck, savePCDecisions, sendPulseCheckReady |
| Revisions | generateRevision, processRevision, getRevisions, sendRevisionReady |
| Reports | generateReport, getReport |
| AI Helpers | suggestDescription |
| Admin | getSettings, updateSettings, deleteAccount, adminTenants, publicConfig, usageReport |
| Billing | stripeWebhook, createCheckoutSession |
| Scheduling | closeExpiredItems, purgeTranscripts |
| Cache | primeCacheWorker |
| Security | health, bedrockHealth, shieldCallback |

## Development

```bash
npm install                          # Install all workspaces
npm run dev --workspace=apps/admin-ui   # Run admin UI locally
npm run dev --workspace=apps/session-ui # Run session UI locally
```

## Deployment

- Push to `main` → auto-deploys to dev
- Manual dispatch → promote to staging or prod (requires "DEPLOY" confirmation for prod)
- CI/CD: GitHub Actions with OIDC, Semgrep + Checkov security scanning, smoke tests covering all 64 Lambdas

### Environment URLs

| Environment | Frontend | API | Status |
|---|---|---|---|
| Dev | https://pulse.urgdstudios.com (dev stage) | https://api.pulse.urgdstudios.com/dev | Auto-deploy on push to main |
| Staging | https://pulse.urgdstudios.com (staging stage) | https://api.pulse.urgdstudios.com/staging | Manual promotion |
| Prod | https://pulse.urgdstudios.com | https://api.pulse.urgdstudios.com/prod | Manual promotion, requires DEPLOY confirmation |

## Standards

See `urgd_library/standards/` for Lambda, CloudFormation, CI/CD, Frontend, and Security standards.

---

## Version History

### v1.2.1 — May 2026

Beta audit fixes — prompt quality, scheduling reliability, reviewer-facing text.

- **Prompt guardrails (beta audit)** — 7 new behavioral constraints added to `buildSystemPrompt.mjs`:
  - No interpretation-first pattern: model must ask before naming, reflect before expanding
  - Visual hedging: image descriptions use "appears to", "reads as"; model defers immediately if corrected
  - Terse-reviewer adaptation: after 3+ short/negative responses, model pivots to open-ended redirect or offers exit
  - Mandatory final-word turn: model must ask "anything else?" before every `[SESSION_COMPLETE]`
  - No ur/gd Studios mention: model never references its creator to reviewers
  - No leading questions with embedded preferred answers
  - No value-laden framing before reviewer signals their own read
- **CompletionCard text fix** — changed "Your responses have been shared with the team" to "the item owner" (previously leaked tenant identity or showed generic text)
- **Close scheduling reliability** — batch sweep changed from `rate(12 hours)` to `cron(0 0,6,12,18 * * ? *)` (4x daily: midnight, 6am, noon, 6pm UTC). Items now close within 6 hours max even if per-item EventBridge schedule fails
- **Removed silent closeDate fallback** — file-upload path no longer silently sets `closeDate` to `Date.now() + 30 days` when the field is empty. Requires explicit user input
- **Backfill script** — `scripts/backfill-close-schedules.mjs` creates EventBridge schedules for active items that predate the scheduler deployment

### v1.2 — April 2026

Async revision delivery + counter accuracy + UX improvements.

- **Async revision delivery** — revisions now default to async mode controlled by `REVISION_DELIVERY_MODE` feature flag (`'async'` default, `'sync'` for rollback). Frontend shows confirmation message instead of polling spinner; user receives a branded SES email with a direct link when the revision is ready. Flag flip to `'sync'` restores polling UX — no deploy needed
- **`sendRevisionReady` Lambda (#64)** — new Lambda async-invoked by `processRevision` when delivery mode is `'async'`. Sends branded email via SES. On SES failure: logs error, publishes SNS alert, does NOT mark revision as failed
- **Annotated change lists for PDF/DOCX** — `processRevision` uses a structured change list prompt for PDF/DOCX items, producing `### Change N` Markdown with location, original text, replacement, and rationale. Frontend detects format and renders change cards instead of full-document rewrite
- **Counter decrement accuracy** — new `decrementCounter()` shared utility in `counters.mjs` ensures cancelled, expired, and deleted sessions/items are subtracted from monthly usage counters. Zero-clamping prevents negative drift. Used by `cancelSession`, `expireSessions`, `expirePublicSession`, and `deleteItem`
- **`hasCompletedRevision` on items API** — `getItems` queries REVISIONS_TABLE GSI for completed revisions, added to item response for frontend action button logic
- **State-responsive action buttons** — `getItemActions()` pure function maps item lifecycle state to visible actions (max 2). Used on item cards, detail modal, and invite modal
- **Invite Modal restructure** — renamed to "Sessions & Feedback" with 3-zone layout: Create Sessions (with self-review), Active Sessions, and Item Actions (with Revisions link)
- **Upload format nudge** — informational hint for PDF/DOCX uploads suggesting `.md`/`.txt` for better revision experience
- **Feature flag count: 18** (added `REVISION_DELIVERY_MODE` string flag resolved via `resolveDeliveryMode()`, not `resolveFeature()`)

### v1.1 — April 2026

Session start redesign + platform hardening.

- **Instant session greeting** — template greetings stored on item records at document-ready time. Reviewers see the opening message the moment the chat page loads — zero Bedrock latency, zero cost per session start
- **Streaming-first architecture** — all auto-send signals (`__session_start__`, `__session_resume__`, `__session_end__`) now use the Lambda Function URL streaming path instead of API Gateway, eliminating 504 timeout risk
- **Two-phase session flow** — Phase 1 displays the template greeting instantly; Phase 2 streams the AI's first substantive response when the reviewer is ready. Replaces the PreGenerate Lambda approach that took 23-27 seconds
- **Native document context** — PDF and DOCX files are sent directly to the model (Converse API), so the AI sees formatting, layout, and images — not just extracted text
- **Smarter session pacing** — AI allocates conversation time based on section word count × depth preference instead of equal time per section
- **"Anything else?" closing turn** — AI asks one open-ended question before the summary, giving reviewers a chance to surface unprompted thoughts
- **CORS preflight coverage** — 10 missing OPTIONS methods added to API Gateway for PUT/DELETE/PATCH resources
- **Security hardening** — input validation on template greeting writes, path traversal guard in renderPages, ConditionExpression guards on session status transitions
- **PreGenerate retirement** — Lambda invocations removed from AcceptConfidentiality and CreateSelfSession; IAM permissions and env vars cleaned up from CloudFormation. Lambda code retained for potential future use
- **75 new tests** — 7 property-based tests (fast-check), 8 unit test suites, 1 frontend test suite covering the full two-phase flow
- **Drop page images from Turn 3** — page images removed from default document injection behind `INCLUDE_PAGE_IMAGES_ON_INJECTION` feature flag (default: false). Reduces worst-case TTFT from ~43s to ~10s. Native PDF block provides document structure, layout, and text without vision encoder latency. One-click rollback via env var.
- **TTFT instrumentation** — time-to-first-token measured and logged for all streaming responses. CloudWatch metric `TimeToFirstToken` published in `Pulse/Chat` namespace for latency monitoring.
- **Phased cache priming** — Priming Worker warms Bedrock prompt cache at session entry. Cache prefix alignment maintained between priming and Turn 3 for both flag states.
- **System prompt honesty guardrail** — when page images are excluded, the model accurately describes its capabilities and redirects photo/graphic questions to observable metadata (position, captions, alt text) without revealing technical details.
- **State machine hardening** — ConditionExpression guards added to 6 DynamoDB write paths (closeItem, closeExpiredItems, inviteReviewer, createPublicSession, analyzeDocument, extendDeadline) preventing TOCTOU race conditions on item status transitions.
- **CloudFormation test visibility** — 3 property tests renamed from .js to .mjs and added to vitest config, surfacing concurrency budget validation.
- **Streaming paragraph fix** — fixed newline collapse in session-ui streaming where `\n\n` paragraph breaks were stripped by intermediate chunk processing.
- **Self-review session display** — InviteModal now shows only the most recent self-review session, hiding cancelled predecessors from "start over" flow.
- **Pulse DevTools MCP** — custom MCP server for dev/staging debugging (session lookup, conversation transcripts, CloudWatch log tailing, metrics) — no AWS console context-switching needed.

### v1.0 — March 2026

Initial release. AI-guided feedback sessions, Pulse Check synthesis, proposed revisions, tiered billing, public session links, QR codes, PDF export.

---
*Pulse v1.2.1 — ur/gd Studios — us-west-2*
