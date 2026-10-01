# Security Audit Report — NIDIKUMBA CRM — 2026-09-10

Scope: `whatsapp-backend/` (Express API, 82 routes), `whatsapp-dashboard/` (React/Vite),
`docker-compose.yml`, both Dockerfiles, `nginx.conf`, `.github/workflows/`, `migrations/`, git history.

Sensitive data at risk: customer names, WhatsApp/phone numbers, delivery addresses, order and
payment history, full WhatsApp chat transcripts, staff password hashes.

---

## Summary

**Total findings: 18 — Critical: 3, High: 6, Medium: 6, Low: 3**

### Most urgent 3

1. **[CRITICAL] A real Anthropic API key and a guessable Meta webhook token are permanently in git
   history, reachable from `origin/main` on GitHub.** Independently verified: commit `e5859b1`
   (2026-08-05) added `.env`; `git branch -r --contains` confirms it is on `origin/main`,
   `origin/HEAD`, `origin/phase12-final-qa`, `origin/refactor/code-quality`, and
   `origin/copilot/fix-deploy-to-vm-job` at `github.com/Dil123852/CRM-Automation.git`.
2. **[CRITICAL] Live production secrets sit in plaintext on the developer workstation** at
   `whatsapp-backend/.env` — including `JWT_SECRET`, which allows minting a valid
   `role: 'admin'` token and reading the entire customer database.
3. **[CRITICAL] Four routes serving customer PII, full chat logs and all order financials have no
   role gate at all.** `GET /api/customers/:id` returns every WhatsApp message for a customer to
   *any* authenticated role — directly bypassing the `PIPELINE_READ_ROLES` restriction that the
   equivalent `GET /api/messages` enforces.

A theme worth stating plainly: **authorization in this API has exactly one dimension — role.**
Only two places in 4,300 lines compare `req.staff.id` against a record
(`GET /api/performance`, and `callVisibilityFilter` for one lead source). No customer, order, lead
or chat log is scoped to the staff member who owns it.

---

## Findings

### [CRITICAL] Real secrets committed to git history and pushed to GitHub

- **Location:** commit `e5859b1807c2ccc3c41a02efdd7ad5529038e295`, file `.env`
- **Issue:** The commit contains `ANTHROPIC_API_KEY=sk-ant-api03-8nok9uim…` (real prefix, full
  95-char high-entropy body), `VERIFY_TOKEN=raigam_webhook_2026` (real and guessable), and
  `POSTGRES_PASSWORD=crm_secret`. A later commit untracked the file, which does **not** remove it
  from history. I verified the current on-disk Anthropic key **differs** from the historical one,
  consistent with a rotation — but revocation must be confirmed in the console, not assumed.
- **Exploit scenario:** Anyone with read access to the repo (or anyone at all, if it is or ever was
  public, or if a fork exists) runs `git show e5859b1:.env`. The `VERIFY_TOKEN` lets an attacker
  complete Meta's webhook handshake. If the Anthropic key were not revoked, they bill API usage to
  the company account.
- **Fix:** (1) Confirm `sk-ant-api03-8nok9uim…` is revoked in the Anthropic console. (2) Rotate
  `VERIFY_TOKEN` — it is guessable by pattern regardless of history. (3) Purge with
  `git filter-repo --path .env --invert-paths`, force-push all branches, have every collaborator
  re-clone. Note that if the repo is public or forked, GitHub retains the blobs and **rotation is
  the only real fix**. (4) Enable GitHub secret scanning + push protection. (5) Add
  `gitleaks`/`trufflehog` to `ci.yml` — the existing `security-audit` job only runs `npm audit` and
  would not have caught this.
- **Effort:** medium

### [CRITICAL] Live production secrets in plaintext on disk, including the JWT signing key

- **Location:** `whatsapp-backend/.env` lines 1, 3, 8, 9, 16, 19
- **Issue:** Real, live values for `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`
  (`AC…` + 32 hex), `TWILIO_AUTH_TOKEN`, `JWT_SECRET` (64-char base64), and
  `CALL_TRACKER_API_KEY`. Correctly git-ignored and correctly excluded from the Docker image via
  `.dockerignore` — but present unencrypted on a workstation.
- **Exploit scenario:** `JWT_SECRET` is the worst of these. With it, an attacker forges
  `jwt.sign({id, name, role:'admin'}, SECRET)` matching the shape at `index.js:854` and has full
  admin against production — every customer, address, chat log and payment record. No lockout, no
  revocation, no audit trail would show it. The Twilio token additionally allows sending WhatsApp
  messages as the business.
- **Fix:** Rotate all five now. Rotating `JWT_SECRET` invalidates all staff sessions — that is the
  desired outcome. Move production secrets to the host's secret store / compose `env_file` outside
  the repo tree, and treat this file as compromised: review backend access logs for unexpected
  `/api/` traffic.
- **Effort:** small (rotation) / medium (secret management)

### [CRITICAL] Four data-serving routes have no role gate; one leaks all chat logs

- **Location:** `whatsapp-backend/index.js:1904` (`GET /api/customers`), `:2050`
  (`GET /api/customers/:id`), `:3262` (`GET /api/orders`), `:3277` (`GET /api/orders/:id`)
- **Issue:** Verified by `awk` over every route registered after the auth boundary
  (`app.use('/api', authenticate)`, line 1203): these four have no `requireRole`. Any of the six
  roles with a valid token reaches them. `GET /api/customers/:id` returns
  `SELECT * FROM customers` **plus the complete `messages` history** for that customer. The
  equivalent `GET /api/messages` at line 2120 *is* gated to `PIPELINE_READ_ROLES` — which
  deliberately excludes `delivery_coordinator`, a restriction CLAUDE.md records as confirmed with
  the user. Line 2050 silently undoes it.
- **Exploit scenario:** A `delivery_coordinator` — whose job is fulfillment on placed orders —
  authenticates, calls `GET /api/customers` (no `LIMIT`, so the whole table: names, both phone
  numbers, `lifetime_value`, `priority_score`, marketing consent), then iterates
  `GET /api/customers/:id` to exfiltrate every customer's full WhatsApp conversation. Same path
  gives `inventory_manager` and `viewer` the entire order book with totals and payment status.
- **Fix:** Add `requireRole(...PIPELINE_READ_ROLES)` to 2050 and 2120's peers; gate 1904 to
  `admin`/`viewer`/`sales_agent` (matching the stricter `GET /api/customers-directory` at 1937,
  which is a *less* permissive duplicate of the same data); gate 3262/3277 to
  `admin`/`finance`/`sales_agent`/`viewer`; add `LIMIT`/pagination to line 1918.
- **Effort:** small

### [HIGH] `advance_required` bypasses the payment/pricing role separation

- **Location:** `whatsapp-backend/index.js:3323` (allowlist), `:3326-3335` (gates), `:3461-3478`
  (side effect)
- **Issue:** `PATCH /api/orders/:id` gates `paymentFields = ['payment_status','payment_method']` to
  admin/finance and `pricingFields = ['items','total_amount']` to admin/sales_agent. Verified
  `advance_required` is in the `allowed` array but in **neither** gate — yet setting it inserts a
  real row into `order_payments` (line 3471), and the `trg_order_payment_change` trigger then
  derives `orders.amount_paid` and `orders.payment_status`.
- **Exploit scenario:** A `sales_agent`, explicitly 403'd from `payment_status`, sends
  `PATCH /api/orders/<any-id> {"advance_required": <order total>}`. The ledger records a full
  "advance", the trigger flips `payment_status` to `paid`, and the order becomes deliverable
  without money being received. Because `GET /api/orders` is ungated, they can enumerate every
  order id first. Reductions are deliberately not reversed (line 3459), so paid-ness only ratchets
  upward.
- **Fix:** Add `advance_required` (and `is_custom_order`) to `paymentFields`. If sales agents
  genuinely need to record counter advances, keep that on `POST /api/orders/:id/payments`, which
  grants them ledger writes intentionally — and then the 3331 check is meaningful rather than
  bypassable.
- **Effort:** small

### [HIGH] `POST /webhook` accepts unauthenticated input and spends money

- **Location:** `whatsapp-backend/index.js:1560`
- **Issue:** The Meta webhook has **no signature verification**. I grepped the entire file for
  `x-hub`, `hub.signature` and `appsecret` — never checked anywhere. The handler feeds
  attacker-controlled `from` and `text` straight into `processIncomingMessage`, which creates
  `customers` rows, inserts `messages`, calls the **paid Claude API**, and sends WhatsApp replies.
  By contrast `POST /webhook/twilio` (line 1586) *does* validate `X-Twilio-Signature` — but only
  when `TWILIO_VALIDATE_SIGNATURE !== 'false'`, so a single env var disables it.
- **Exploit scenario:** `curl -X POST https://crm.nidikumba.shop/webhook -d '{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"messages":[{"type":"text","from":"94700000000","text":{"body":"..."}}]}}]}]}'`
  in a loop. Each request costs an Anthropic call and pollutes the CRM with fake customers, fake
  leads (auto-assigned to real staff with real SLA clocks) and fake chat history. The
  `webhookLimiter` caps this at 120/min per IP — meaningful but not a fix, and bypassable from
  multiple sources.
- **Fix:** Verify Meta's `X-Hub-Signature-256`:
  `crypto.timingSafeEqual(Buffer.from('sha256=' + crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')), Buffer.from(req.get('X-Hub-Signature-256')))`.
  This needs the raw body, so add `express.json({ verify: (req,_res,buf) => { req.rawBody = buf; } })`.
  Also remove the `TWILIO_VALIDATE_SIGNATURE` escape hatch, or fail closed unless
  `NODE_ENV !== 'production'`.
- **Effort:** medium

### [HIGH] Deactivating or demoting a staff member does not end their session

- **Location:** `whatsapp-backend/index.js:140-149` (`authenticate`), `:854` (12h expiry)
- **Issue:** `authenticate` calls `jwt.verify` and trusts the token's `role` claim. It never
  re-reads `staff_users`. Verified there is no logout route, no `token_version`, no denylist
  anywhere in the file.
- **Exploit scenario:** A staff member is fired. Admin sets `active=false`. Their existing token
  keeps working — with their original role — for up to 12 hours, across every route. Deactivation
  is not a functioning incident-response control. Same applies to demotion: a demoted admin retains
  admin for the rest of the token's life.
- **Fix:** In `authenticate`, after `jwt.verify`, `SELECT role, active FROM staff_users WHERE id=$1`
  and 401 if `!active`; use the DB role rather than the claim. That is one indexed lookup per
  request. If that cost is unacceptable, add a `token_version` column bumped on
  deactivation/demotion and compare it against a claim.
- **Effort:** small

### [HIGH] No password policy on staff creation

- **Location:** `whatsapp-backend/index.js:1249-1251` vs `:1303`
- **Issue:** `POST /api/staff` accepts any non-empty password — no length or complexity check.
  `PATCH /api/staff/:id/password` requires only `length >= 6`. Verified: the create path has no
  `password.length` check at all. These accounts read the entire customer database.
- **Exploit scenario:** An admin creates a user with password `a`. Combined with no account lockout
  (below), that account is trivially brute-forced.
- **Fix:** Extract one validator (minimum 12 characters, reject the top-1000 common list) and apply
  it to both routes. Hashing itself is correct — bcrypt cost 10 at lines 1255/1308.
- **Effort:** small

### [HIGH] No account lockout; login brute-force limited only per-IP

- **Location:** `whatsapp-backend/index.js:833-839`
- **Issue:** `loginLimiter` is 10 attempts / 15 min with the default per-IP key. There is no
  per-account counter, no lockout, no exponential backoff — verified no `failed_login`/`lockout`
  column or logic exists.
- **Exploit scenario:** A distributed attacker gets 10 guesses per IP per 15 minutes against a
  single known admin phone number, with no account-side signal and nothing logged. With no password
  policy on creation, weak passwords are plausible targets. `trust proxy: 1` is set correctly
  (line 25), so `X-Forwarded-For` spoofing does **not** bypass the limiter — that part is right.
- **Fix:** Add a per-account attempt counter with backoff (e.g. `failed_login_count` +
  `locked_until` on `staff_users`), keyed on the submitted phone as well as IP.
- **Effort:** medium

### [HIGH] Raw database error messages returned to clients on ~70 endpoints

- **Location:** `whatsapp-backend/index.js` — 75 occurrences of
  `res.status(500).json({ error: err.message })`
- **Issue:** Postgres error text — constraint names, column names, types — is returned verbatim.
- **Exploit scenario:** An attacker probes endpoints and reads back schema details from constraint
  violations (`orders_cod_requires_cash_payment`, `customers_whatsapp_number_canonical`), mapping
  the data model to find further weaknesses.
- **Fix:** Return a generic `{ error: 'Internal server error' }` and `console.error` the real one
  server-side. The global handler at line 4258 already does exactly this — the per-route handlers
  should match it. **Caution:** 6 of these catch blocks have `err.code === '23505'/'23503'`
  pre-checks mapping duplicate keys to a 409 (lines 1266, 2390, 2397, 2437, 3986, 4053). A
  mechanical sweep that drops one silently turns a 409 into a 500 — change them individually.
- **Effort:** medium

### [MEDIUM] No per-record ownership model anywhere in the API

- **Location:** whole file; only `index.js:1323` and `:2190` scope by `req.staff.id`
- **Issue:** `callVisibilityFilter` (line 2190) hides only leads whose `source` is literally
  `'Call tracker app'`, from non-admin/viewer, on only two routes (2205, 2226). Every other lead,
  customer, order and chat is global to the role. The filter is also defeated by sibling routes:
  `GET /api/calls` (1215) dumps the same call data unfiltered to all `PIPELINE_READ_ROLES`, and
  `GET /api/leads/:id/items` (2298) and `GET /api/customers/:id` (2050) return the lead without it.
- **Exploit scenario:** Sales agent A reads, edits and closes agent B's leads
  (`PATCH /api/leads/:id`, 2411, no scoping), claims quotation numbers on them (2250), and reads
  every customer conversation.
- **Fix:** This is a design change, not a patch. Either accept that all staff see all records and
  document it, or add an ownership dimension (`assigned_staff_id` is already on `leads`) and filter
  consistently — starting with the routes that currently defeat `callVisibilityFilter`.
- **Effort:** large

### [MEDIUM] `delivery_coordinator` writes payment ledger rows on delivery

- **Location:** `whatsapp-backend/index.js:3401-3443`
- **Issue:** Setting `status='delivered'` without `payment_status` inserts a `kind='balance'`
  `order_payments` row for the full outstanding amount with `recorded_by: req.staff.id`. The role
  is allowed `status` (line 3343) but 403'd from all payment fields. The behaviour is intentional
  for COD (documented at 3392-3400) but fires **unconditionally**, regardless of `delivery_method`
  or `payment_method`.
- **Exploit scenario:** A card-prepaid or disputed order is marked delivered and is silently
  recorded as fully collected in cash, in the coordinator's name.
- **Fix:** Gate the auto-payment on `isCOD(order.delivery_method)`; for non-COD, require
  `payment_status` to already be `paid` (the `orders_delivered_requires_paid` constraint then does
  the rest).
- **Effort:** small

### [MEDIUM] `finance` and `sales_agent` can rewrite customer identity on any order

- **Location:** `whatsapp-backend/index.js:3315-3316`
- **Issue:** `customer_name` and `customer_phone` are in `allowed` but in neither `paymentFields`
  nor `pricingFields`, so they are writable by admin, sales_agent and finance on any order.
- **Exploit scenario:** Order attribution is altered after the fact — reassigning a sale, or
  redirecting a delivery confirmation to an attacker-controlled number (the confirmation message is
  sent to `orders.customer_phone`).
- **Fix:** Add both to `pricingFields`, or gate them to `admin`.
- **Effort:** small

### [MEDIUM] No audit logging of authentication, authorization or admin actions

- **Location:** `whatsapp-backend/index.js:147` (401), `:154` (403); no audit table in
  `migrations/` or `db/init.sql`
- **Issue:** Verified zero `console` calls near the 401/403 returns and no `staff_activity_log` or
  `audit_log` table anywhere. CLAUDE.md confirms REQ-4.7/4.8's activity log was never built.
  Staff mutations (`PATCH /api/staff/:id`) don't even emit a `broadcastEvent`, unlike every other
  mutating route.
- **Exploit scenario:** An attacker with a forged or stolen token reads the entire customer database
  and leaves no trace. Post-incident, there is no way to establish what was accessed — which also
  blocks any breach-notification assessment.
- **Fix:** Log every 401/403 with IP, path and staff id; add an `audit_log` table written on
  login success/failure, role changes, password resets, deletions and bulk sends.
- **Effort:** medium

### [MEDIUM] `crm_secret` is the committed default database password

- **Location:** `docker-compose.yml:9` and `:34`, `whatsapp-backend/.env.example:2`
- **Issue:** `${POSTGRES_PASSWORD:-crm_secret}`. If the host `.env` is missing the variable (and
  CLAUDE.md records that this root `.env` does not exist in the repo), Postgres initialises with a
  password that is *also* published in git history at `e5859b1:.env`.
- **Exploit scenario:** An attacker with any foothold on the host, or on the Docker network,
  authenticates to Postgres with a known password. Mitigating: line 14 binds it to
  `127.0.0.1:5432`, so it is not directly internet-reachable.
- **Fix:** Use `${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required}` in both places so it fails closed,
  exactly as `JWT_SECRET` already correctly does at `index.js:119-122`.
- **Effort:** small

### [MEDIUM] Dependency vulnerabilities (real `npm audit` output below)

- **Location:** `whatsapp-backend/package.json` (express→body-parser→qs),
  `whatsapp-dashboard/package.json` (xlsx, vitest)
- **Issue:** 3 moderate (backend), 1 high + 4 moderate (frontend).
- **Fix:** Backend: `npm audit fix` (non-breaking, patches `qs`). Frontend: `xlsx@0.18.5` has **no
  fix available** and SheetJS no longer publishes to npm — but both advisories require *parsing*
  untrusted spreadsheets, and this app only ever writes. CI already enforces that with a step that
  fails the build if `XLSX.read`/`readFile` appears in `src/`; I verified it still returns nothing.
  Keep that gate. Vitest is dev-only (not shipped).
- **Effort:** small

### [MEDIUM] SSE endpoint accepts the token in the query string

- **Location:** `whatsapp-backend/index.js:136` (`getToken`), `:1397`, `:1401`
- **Issue:** `if (req.query.token) return req.query.token;` — necessary because `EventSource`
  cannot set headers, but it puts a 12-hour admin-capable bearer token into nginx access logs,
  browser history and any `Referer`. Line 1401 also sets `Access-Control-Allow-Origin: '*'` on the
  stream.
- **Exploit scenario:** Anyone who can read the reverse-proxy logs (or shoulder-surf a URL) obtains
  a working session token.
- **Fix:** Accept `?token=` only on `/api/events`, not globally in `getToken`. Better: issue a
  short-lived single-purpose SSE ticket. At minimum, strip `token` from nginx's `log_format`.
- **Effort:** small

### [LOW] `jwt.verify` does not pin the algorithm

- **Location:** `whatsapp-backend/index.js:144`
- **Issue:** No `{ algorithms: ['HS256'] }` option. **I tested this rather than assuming:**
  `jsonwebtoken@9.0.3` rejects a forged `alg:none` token (`jwt signature is required`), and the
  secret is symmetric so RS→HS confusion does not apply. So this is hardening, not a live
  vulnerability.
- **Fix:** `jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] })`.
- **Effort:** small

### [LOW] Missing HSTS and CSP; security headers dropped for static assets

- **Location:** `whatsapp-dashboard/nginx.conf:14-17` and `:71-74`
- **Issue:** No `helmet` in the backend (verified absent) and no HSTS or CSP anywhere. Separately,
  nginx's `add_header` does not inherit into a `location` that declares its own: the static-asset
  block at line 14-17 sets `Cache-Control`, which **drops all four** server-level security headers
  for every `.js`/`.css`/image response.
- **Fix:** Add `Strict-Transport-Security` and a CSP at the TLS-terminating proxy; repeat the four
  `add_header` lines inside the static block (or use nginx ≥1.7.5 `always` with an include).
- **Effort:** small

### [LOW] Frontend container runs as root; build ARG persists in image layers

- **Location:** `whatsapp-dashboard/Dockerfile:17-19`, and no `USER` directive
- **Issue:** `ARG`/`ENV VITE_BACKEND_URL` persists in image metadata (`docker history`). The value
  is only a URL, so this is acceptable today — but it becomes a real leak the moment anyone adds a
  secret-bearing `VITE_` variable. The nginx stage never sets `USER`. The **backend** Dockerfile is
  correct by contrast (non-root `USER nodejs` at line 32, no ARGs).
- **Fix:** Add a comment warning against secret-bearing `VITE_` vars; use
  `nginxinc/nginx-unprivileged` or an explicit `USER nginx` with a port > 1024.
- **Effort:** small

---

## Checked, no issue found

**Phase 0 — Recon.** Stack: Node 20 + Express 4, self-hosted PostgreSQL 16 (no ORM — raw `pg`),
React 18 + Vite 7, JWT auth (`jsonwebtoken`), Docker Compose behind an external nginx, npm. 82 route
registrations, 7 public (verified by line number against the `app.use('/api', authenticate)`
boundary at 1203): `/health`, `/api/auth/login`, `/api/promo-codes/validate`, `/api/promo-codes/redeem`,
`/api/webchat`, `/api/calls`, `/api/calls/start`. Plus 3 webhooks. 6 roles. 1 cron job
(`runFollowUpScheduler`, 15 min).

**SQL injection — clean.** All 12 sites that build SQL with interpolation were read individually.
Ten use `setClauses` derived from a hardcoded `allowed` array (column names never come from client
keys), with values passed as positional parameters — verified all 10 allowlists exist. Line 4190's
`SELECT * FROM ${view}` resolves `view` through the hardcoded `REPORT_VIEWS` map with a 404 on miss.
Line 4121's `${where}` is assembled from fixed strings with parameterized values. Line 673 (in
`analyzeConversation`) builds keys from a hardcoded field list, not from AI output. No `$queryRaw`
equivalent, no dynamic table names from input.

**Mass assignment — clean.** No handler spreads `req.body`. Every one of the 10 PATCH routes uses an
explicit `for (const key of allowed)` allowlist. Specifically verified **not** client-settable:
`staff_users.password_hash` (never in any allowlist; only written from `bcrypt.hash`),
`customers.priority_score`, `orders.amount_paid` (DB-derived by trigger). Prototype-pollution keys
(`__proto__`, `constructor`) are ignored because only keys already in `allowed` are read.

**Privilege escalation via self-signup — none.** No `/register` or `/signup` route exists.
`POST /api/staff` is admin-only and validates `role` against `STAFF_ROLES`. Role comes from the DB
row at sign time (line 854), so a forged `role` claim requires `JWT_SECRET`.

**`password_hash` never returned to a client.** All 8 `staff_users` queries use explicit column
lists; there is no `SELECT * FROM staff_users` anywhere. The login response returns
`{id, name, role}` only.

**Password hashing — correct.** bcrypt cost 10 (lines 1255, 1308), `bcrypt.compare` for
verification. No MD5/SHA1/plaintext.

**Command injection — none.** No `child_process`, `exec`, `execSync` or `spawn` in the codebase.

**Insecure deserialization — none.** No `eval`, `new Function`, `vm`, or custom deserializer.

**File uploads — not applicable.** No `multer`/`formidable`/`busboy`/`multipart` handling anywhere;
there is no upload surface. The promo image is a pasted URL fetched by Twilio's servers, not stored.

**SSRF — none.** All three `fetch` calls target hardcoded URLs (`WHATSAPP_API_URL`, Twilio's typing
endpoint). The admin-set promo image URL is passed to Twilio/Meta as `mediaUrl`, fetched by *their*
infrastructure, never by this server.

**Rate limiting — present and actually applied.** All 5 limiters are defined *and* wired to routes
(verified by line number, not just by import): `loginLimiter` (10/15min), `promoCodeLimiter`
(20/15min, on both public promo routes), `webchatLimiter` (30/15min), `callTrackerLimiter`
(60/min), `webhookLimiter` (120/min, on all 3 webhooks). `trust proxy` is `1`, not `true`, so
`X-Forwarded-For` cannot be spoofed to bypass them — CLAUDE.md records this as a previously fixed
bug and it is still correct.

**Body size limits — set.** `express.json`/`urlencoded` capped at 5mb (line 30-31), deliberately
raised from the 100kb default for the call-tracker batch sync.

**CORS — correctly scoped.** Not `*` for authenticated routes: only the 3 deliberately public paths
get `Access-Control-Allow-Origin: *`; everything else is echoed only if the origin is in
`CORS_ALLOWED_ORIGINS`. No `Access-Control-Allow-Credentials: true` paired with a wildcard.

**Frontend bundle — no secrets.** Exactly one `VITE_` variable exists (`VITE_BACKEND_URL`, a URL).
The built `dist/` was grepped directly: zero matches for `sk-ant-`, `AC[0-9a-f]{32}`,
`AKIA[0-9A-Z]{16}`, or JWT-shaped `eyJ` strings. All `SECRET`/`PASSWORD` hits are library noise
(React internals, xlsx's BIFF record-name table).

**`.gitignore` — now correct.** `.env`, `.env.local`, `.env.*.local` ignored with `!.env.example`;
also `backups/`, `*.pem`, `*.key`, `*.crt`. The four tracked env files are all `.example` or the
empty `.env.production`. The historical leak happened because git was already tracking the file, so
the rule never applied.

**Backend Docker image — good posture.** Non-root (`USER nodejs`, line 32), no build ARGs, and
`.dockerignore` excludes `.env`/`.git`/`tests` — the real `.env` is not baked into the image.

**`seed-admin.js` — no default credentials.** Requires `SEED_ADMIN_PHONE`/`SEED_ADMIN_PASSWORD`
from env and exits 1 if absent; bcrypt cost 10. `db/init.sql` seeds no credentials.

**CI/CD secrets — clean.** Both workflows reference `${{ secrets.* }}` only; no inline values, no
secrets echoed to build logs. Third-party actions are pinned to release tags
(`actions/checkout@v5`, `appleboy/ssh-action@v1.0.3`) — mutable tags rather than commit SHAs, which
is conventional but worth tightening for the SSH action that holds a deploy key.

**No credential logging.** Grepped every `console.log`/`console.error` for `req.body`, `password`,
`token`, `Authorization` — no request bodies or credentials are logged.

**Not applicable to this stack:** NoSQL injection (no NoSQL), ORM raw-query risk (no ORM), XXE (no
XML parsing beyond Twilio's form encoding), template injection (no server-side template engine),
unsigned auto-update channels (none), directory listing (nginx `autoindex` is off by default and
not enabled).

---

## Dependency audit output

### `whatsapp-backend` — `npm audit`
```
qs  2.2.5 - 6.15.3
Severity: moderate
  qs array-limit bypass via bracket-key comma parsing — GHSA-x5fp-wj9c-mxmx
  qs: Denial of Service via Attacker Controlled isBuffer — GHSA-4mjr-xmp4-gh2g
fix available via `npm audit fix`
node_modules/qs
  body-parser  1.20.5 - 1.20.6  (depends on vulnerable qs)
  express      4.22.2           (depends on vulnerable qs)

3 moderate severity vulnerabilities
```
**Reachable?** Yes — `qs` parses every query string and urlencoded body, including on the
unauthenticated webhooks. Both are DoS/limit-bypass, not RCE. `npm audit fix` is non-breaking here.

### `whatsapp-dashboard` — `npm audit`
```
xlsx  *
Severity: high
  Prototype Pollution in sheetJS — GHSA-4r6h-8v6p-xvw6
  SheetJS Regular Expression Denial of Service (ReDoS) — GHSA-5pgg-2g8v-p4x9
No fix available
node_modules/xlsx

@vitest/mocker (via vitest, @vitest/ui, @vitest/coverage-v8)
Severity: moderate
  Vitest: Path Traversal / Arbitrary File Read via @vitest/mocker Redirect Mock — GHSA-82fw-gwwq-j7x9
fix available via `npm audit fix --force` (installs vitest@5.0.0, breaking)

5 vulnerabilities (4 moderate, 1 high)
```
**Reachable?** **No, for both.** The `xlsx` advisories require parsing attacker-supplied
spreadsheets; this app only *writes* `.xlsx` exports. `ci.yml`'s `security-audit` job already fails
the build if `XLSX.read`/`readFile` ever appears in `src/` — I re-ran that grep and it returns
nothing, so the gate holds. Vitest is a dev dependency and is not shipped to the browser.

**Severity by package:** high 1 (xlsx, unreachable), moderate 4 (vitest dev-only) + 3 (qs,
reachable but DoS-class).
