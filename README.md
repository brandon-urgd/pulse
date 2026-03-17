# Pulse

AI-guided feedback agent — by ur/gd Studios

## Structure

```
pulse/
├── .github/workflows/
│   └── deploy-pulse.yml          # CI/CD — auto-deploy dev on push, manual staging/prod
├── apps/
│   ├── admin-console/            # React 19 + Vite + TypeScript (tenant-facing)
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── App.tsx
│   │       └── api/client.ts
│   ├── session-ui/               # React 19 + Vite + TypeScript (reviewer-facing)
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── App.tsx
│   │       └── api/client.ts
│   └── shared/                   # Shared types, constants, utilities
│       └── src/
│           └── index.ts
├── cloudformation/
│   └── pulse-cloudformation.yaml # All infrastructure as code
├── config/
│   └── preconditions.json        # Promotion health thresholds
├── lambdas/
│   ├── shared/                   # utils.mjs, healthCheck.mjs
│   ├── urgd-pulse-management/    # Tenant ops, item CRUD, invites, pulse check
│   ├── urgd-pulse-session/       # Reviewer conversation flow, Bedrock AI
│   └── urgd-pulse-authorizer/    # Cognito JWT validation
├── scripts/
│   ├── hooks/pre-commit          # Security scan hook
│   ├── setup-dev.sh              # Install pre-commit hook + verify tools
│   ├── preconditions_check.sh    # Pre-promotion health checks
│   └── smoke.sh                  # Post-deployment smoke tests
└── README.md
```

## Development Setup

```bash
./scripts/setup-dev.sh
```

## Deployment

- Push to `main` → auto-deploys to dev
- Manual dispatch → promote to staging or prod (requires "DEPLOY" confirmation for prod)

## Standards

See `urgd_library/standards/` for Lambda, CloudFormation, CI/CD, Frontend, and Security standards.

---
*ur/gd Studios — us-west-2*
