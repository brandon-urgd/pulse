# Pulse

AI-guided feedback platform — by ur/gd Studios

Pulse pairs human reviewers with an AI conversation agent to extract structured, actionable feedback on documents, images, and creative work. Tenants upload content, invite reviewers, and receive synthesized insights through Pulse Checks — AI-generated theme analysis with proposed revisions.

## Architecture

**Frontend:** Two React 19 + Vite + TypeScript apps — `admin-ui` (tenant-facing, 13 pages, 17 components) and `session-ui` (reviewer-facing, 22 pages/components). S3 + CloudFront hosting, WAF-protected via Shield, Cognito-authenticated. React Query, Zod validation, CSS modules with design tokens.

**Backend:** 61 Lambda functions (Node.js 22.x, ES modules), API Gateway REST API (51 routes), dual authorizer system (Cognito JWT for admin routes, session token for reviewer routes). Bedrock Claude for AI conversation, Pulse Check synthesis, and document revision.

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
│   ├── shared/                        # utils.mjs, features.mjs, tiers.mjs
│   └── urgd-pulse-{function}/         # 61 individual Lambda functions
├── scripts/
│   ├── build-lambdas.sh               # Package and upload Lambda ZIPs
│   ├── deploy-frontend.sh             # S3 sync with cache headers
│   ├── smoke.sh                       # Post-deploy smoke tests (61 Lambda coverage)
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

## Lambda Functions (61)

| Category | Functions |
|---|---|
| Auth | cognitoAuth, sessionAuth, register, createTenant, validateSession, acceptConfidentiality |
| Items | getItems, createItem, getItem, updateItem, deleteItem, closeItem |
| Documents | getUploadUrl, extractText, getDocumentUrl, removeDocument, analyzeDocument |
| Sessions | inviteReviewer, getItemSessions, cancelSession, resendInvite, extendDeadline, sendReminder, expireSessions, createPublicSession, getPublicSessionQr, expirePublicSession, previewSession, createSelfSession |
| Conversation | chat, getSessionState, getSessionSummary, generateSessionSummary, deleteSessionTranscript, getSessionFile, emailSessionSummary, submitReport |
| Pulse Check | runPulseCheck, processPulseCheck, getPulseCheck, savePCDecisions, sendPulseCheckReady |
| Revisions | generateRevision, processRevision, getRevisions |
| Reports | generateReport, getReport |
| AI Helpers | suggestDescription |
| Admin | getSettings, updateSettings, deleteAccount, adminTenants, publicConfig, usageReport |
| Billing | stripeWebhook, createCheckoutSession |
| Scheduling | closeExpiredItems, purgeTranscripts |
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
- CI/CD: GitHub Actions with OIDC, Semgrep + Checkov security scanning, smoke tests covering all 61 Lambdas

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

### v1.1 — April 2026

Quality-of-life iteration. No new infrastructure.

- **Smarter session pacing** — AI allocates conversation time based on section word count × depth preference instead of equal time per section
- **Native document context** — PDF and DOCX files are sent directly to the model (Converse API), so the AI sees formatting, layout, and images — not just extracted text
- **"Anything else?" closing turn** — AI asks one open-ended question before the summary, giving reviewers a chance to surface unprompted thoughts
- **Weighted progress bar** — PulseLine reflects content coverage, not just section count
- **Markdown revision rendering** — revision output renders as formatted text instead of raw markdown syntax
- **Progressive patience messages** — three-stage reassurance messages during long operations (45s, 90s, 150s) instead of one generic message
- **Corrected onboarding CTA** — "Explore an example" opens the items list with the example item modal, not the Pulse Check page
- **Full quote display** — Pulse Check synthesis lists show quotes in full without click-to-reveal
- **Bedrock Converse migration** — all 8 Bedrock Lambdas migrated from InvokeModel to Converse/ConverseStream API

### v1.0 — March 2026

Initial release. AI-guided feedback sessions, Pulse Check synthesis, proposed revisions, tiered billing, public session links, QR codes, PDF export.

---
*Pulse v1.1 — ur/gd Studios — us-west-2*
