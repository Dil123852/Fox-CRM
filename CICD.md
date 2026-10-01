# CI/CD & Testing Documentation

Complete guide to the Continuous Integration, Continuous Deployment pipeline, and unit testing setup for the WhatsApp Dashboard project.

---

## Overview

The project uses **GitHub Actions** for CI/CD with the following stages:

```
┌─────────────────────────────────────────────────────────────┐
│  Pull Request / Push                                        │
└────────────┬────────────────────────────────────────────────┘
             ↓
┌─────────────────────────────────────────────────────────────┐
│  CI Pipeline (ci.yml)                                       │
│  ├── Lint & Format Check                                    │
│  ├── Backend Unit Tests (Jest)                              │
│  ├── Frontend Unit Tests (Vitest)                           │
│  ├── Build Frontend                                         │
│  ├── Security Audit (npm audit)                             │
│  └── CodeQL Security Analysis                               │
└────────────┬────────────────────────────────────────────────┘
             ↓ (only on main branch)
┌─────────────────────────────────────────────────────────────┐
│  Deploy Pipeline (deploy.yml)                               │
│  ├── Wait for CI                                            │
│  ├── Deploy Backend (Railway/Render/Fly.io)                 │
│  ├── Deploy Frontend (Vercel/Netlify/Cloudflare)            │
│  └── Notify Slack                                           │
└─────────────────────────────────────────────────────────────┘
```

---

## CI Pipeline (`ci.yml`)

Runs on every push and pull request to `main` and `develop` branches.

### Jobs

| Job | Purpose | Required |
|-----|---------|----------|
| **lint** | ESLint + format check | Yes |
| **backend-tests** | Jest unit & integration tests | Yes |
| **frontend-tests** | Vitest unit tests | Yes |
| **build-frontend** | Verify production build succeeds | Yes |
| **security-audit** | npm audit for vulnerabilities | Optional |
| **ci-success** | Final gate that aggregates results | Required |

### Caching

Dependencies are cached based on `package-lock.json` hash:
- Backend: `whatsapp-backend/package-lock.json`
- Frontend: `whatsapp-dashboard/package-lock.json`

This significantly reduces CI time (from ~3min to ~30s for cached runs).

---

## Deploy Pipeline (`deploy.yml`)

Runs only on `main` branch pushes or via manual workflow dispatch.

### Configuration

You can choose deployment providers via GitHub Variables:

**For backend (`DEPLOY_PROVIDER`):**
- `railway` — Deploy to Railway
- `render` — Deploy to Render
- `flyio` — Deploy to Fly.io

**For frontend (`FRONTEND_PROVIDER`):**
- `vercel` — Deploy to Vercel
- `netlify` — Deploy to Netlify
- `cloudflare` — Deploy to Cloudflare Pages

### Required Secrets

Configure in GitHub repository settings → Secrets and Variables → Actions:

#### Backend
```
SUPABASE_URL_TEST          # For test environment
SUPABASE_KEY_TEST
ANTHROPIC_API_KEY_TEST
WHATSAPP_TOKEN_TEST

RAILWAY_TOKEN              # If using Railway
RENDER_DEPLOY_HOOK_URL     # If using Render
FLY_API_TOKEN              # If using Fly.io

BACKEND_HEALTH_URL         # For post-deploy health check
```

#### Frontend
```
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_BACKEND_URL

VERCEL_TOKEN               # If using Vercel
VERCEL_ORG_ID
VERCEL_PROJECT_ID

NETLIFY_AUTH_TOKEN         # If using Netlify
NETLIFY_SITE_ID

CLOUDFLARE_API_TOKEN       # If using Cloudflare
CLOUDFLARE_ACCOUNT_ID
```

#### Notifications
```
SLACK_WEBHOOK_URL          # Optional, for deployment notifications
```

---

## Unit Testing

### Backend (Jest)

**Location:** `whatsapp-backend/tests/`

**Test files:**
- `api.test.js` — Endpoint testing (CORS, webhook, send-message, leads, orders, toggle-AI, summary)
- `integration.test.js` — Multi-component flows (webhook → DB → AI analysis)
- `__mocks__/supabase.js` — Supabase client mock
- `__mocks__/anthropic.js` — Anthropic SDK mock
- `setup.js` — Test environment setup

**Running tests:**

```bash
cd whatsapp-backend

# Run all tests with coverage
npm test

# Watch mode (re-run on file changes)
npm run test:watch

# CI mode (verbose, optimized for CI)
npm run test:ci
```

**Coverage thresholds (enforced):**
- Statements: 60%
- Lines: 60%
- Functions: 50%
- Branches: 50%

### Frontend (Vitest + React Testing Library)

**Location:** `whatsapp-dashboard/src/__tests__/`

**Test files:**
- `setup.js` — Global test setup
- `mocks/supabase.js` — Supabase client mock
- `components/MessageBubble.test.jsx` — Message display component
- `components/MessageInput.test.jsx` — Reply input with send logic
- `components/ConversationItem.test.jsx` — Sidebar conversation row
- `components/Toast.test.jsx` — Notification toast
- `utils/time.test.js` — Time formatting helpers

**Running tests:**

```bash
cd whatsapp-dashboard

# Run all tests with coverage
npm test

# Watch mode
npm run test:watch

# Interactive UI
npm run test:ui
```

**Coverage thresholds (enforced):**
- Lines: 50%
- Functions: 50%
- Statements: 50%
- Branches: 40%

---

## Local Development Workflow

### Pre-commit checks

Run these locally before pushing to avoid CI failures:

```bash
# Lint backend
cd whatsapp-backend && npm run lint

# Lint frontend
cd whatsapp-dashboard && npm run lint

# Run all tests
cd whatsapp-backend && npm test
cd whatsapp-dashboard && npm test

# Format code
npx prettier --write .
```

### Running with Docker

```bash
# Start full stack locally
docker-compose up --build

# Frontend: http://localhost:8080
# Backend:  http://localhost:3000
```

---

## Test Writing Guidelines

### Backend (Jest)

```javascript
// Use the provided mocks
jest.mock('@supabase/supabase-js', () => require('./__mocks__/supabase'));
jest.mock('@anthropic-ai/sdk', () => require('./__mocks__/anthropic'));

describe('Feature Name', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should do something specific', async () => {
    // Arrange
    const input = { /* ... */ };

    // Act
    const result = await someFunction(input);

    // Assert
    expect(result).toBe(expected);
  });
});
```

### Frontend (Vitest + RTL)

```jsx
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

describe('MyComponent', () => {
  test('should render and respond to user interaction', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();

    render(<MyComponent onClick={onClick} />);

    await user.click(screen.getByRole('button'));

    expect(onClick).toHaveBeenCalled();
  });
});
```

### Testing Best Practices

- **Arrange-Act-Assert pattern** — Structure tests clearly
- **One assertion per test** when possible — Easier to debug failures
- **Mock external dependencies** — Supabase, Anthropic, fetch
- **Test behavior, not implementation** — Use `getByRole`, `getByTestId` for accessibility
- **Clean up after tests** — Use `afterEach(cleanup)` (auto-configured)
- **Use `userEvent` over `fireEvent`** for realistic user interactions

---

## Docker Deployment

### Backend Container

```bash
cd whatsapp-backend
docker build -t whatsapp-backend:latest .
docker run -p 3000:3000 --env-file .env whatsapp-backend:latest
```

The Dockerfile uses **multi-stage build** for smaller images:
- Stage 1: Install only production dependencies
- Stage 2: Copy deps + code, run as non-root user

**Image size**: ~120MB (Alpine-based)

### Frontend Container

```bash
cd whatsapp-dashboard
docker build \
  --build-arg VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
  --build-arg VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
  --build-arg VITE_BACKEND_URL=$VITE_BACKEND_URL \
  -t whatsapp-frontend:latest .

docker run -p 8080:80 whatsapp-frontend:latest
```

Served via Nginx with:
- Gzip compression
- Aggressive caching of static assets
- SPA route fallback
- Security headers

---

## Security & Monitoring

### CodeQL Analysis (`codeql.yml`)

Runs on every push, PR, and weekly schedule. Scans for:
- SQL injection
- XSS vulnerabilities
- Hardcoded credentials
- Insecure dependencies
- OWASP Top 10 issues

Results appear in GitHub Security tab.

### npm audit

Runs in CI as part of security audit job. Set to `--audit-level=high` to avoid false positives from low-severity issues.

### Recommended Production Hardening

- [ ] Restrict CORS origins (currently `*`)
- [ ] Add rate limiting middleware
- [ ] Implement request validation (e.g., joi/zod)
- [ ] Set up monitoring (Sentry, DataDog, or similar)
- [ ] Configure log aggregation
- [ ] Set up uptime monitoring (UptimeRobot, Better Stack)
- [ ] Enable Supabase Row Level Security (RLS)
- [ ] Rotate API keys regularly
- [ ] Set up backup strategy for Supabase database

---

## Branch Strategy

| Branch | Purpose | CI | Deploy |
|--------|---------|-----|--------|
| `main` | Production code | ✅ Full CI | ✅ Auto-deploy |
| `develop` | Integration branch | ✅ Full CI | ❌ Manual only |
| `feature/*` | Feature branches | ✅ Full CI | ❌ |
| `hotfix/*` | Urgent fixes | ✅ Full CI | Manual via dispatch |

### Recommended PR workflow

1. Create feature branch from `develop`
2. Push commits → CI runs automatically
3. Open PR to `develop` — all checks must pass
4. Merge to `develop` after review
5. Periodically merge `develop` → `main` for release
6. Deploy pipeline triggers automatically

---

## Troubleshooting

### "Tests pass locally but fail in CI"

- Check Node.js version matches (CI uses Node 20)
- Verify environment variables are set in repo secrets
- Look for time-zone dependent tests (use UTC in tests)
- Check for race conditions in async tests

### "Coverage threshold failed"

- Add tests for uncovered branches
- Or temporarily lower thresholds in jest/vitest config (not recommended)
- Run `npm test` locally and check the coverage report HTML

### "Docker build fails on Apple Silicon"

```bash
# Build for specific platform
docker build --platform linux/amd64 -t whatsapp-backend .
```

### "Vercel/Netlify build fails"

- Check that build environment variables are configured
- Verify the build command in their dashboard matches `npm run build`
- Check the build output directory is set to `dist`

---

## Adding New Tests

When adding a new feature:

1. **Backend**: Add test file in `whatsapp-backend/tests/feature-name.test.js`
2. **Frontend**: Add test file in `whatsapp-dashboard/src/__tests__/components/ComponentName.test.jsx`
3. Mock external dependencies (Supabase, Anthropic, fetch)
4. Verify coverage maintains thresholds
5. Update this doc if adding new test categories

---

## Performance Targets

| Metric | Target |
|--------|--------|
| CI run time (full) | < 5 minutes |
| Cached CI run | < 90 seconds |
| Backend Docker image | < 150MB |
| Frontend bundle size | < 500KB gzipped |
| Test coverage | > 60% lines |

---

*Last updated: 2026-05-22*
