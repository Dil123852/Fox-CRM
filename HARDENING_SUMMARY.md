# Complete Hardening Summary — NIDIKUMBA CRM — 2026-09-10

Branch `refactor/code-quality`, 9 commits. Baseline tag: `refactor-baseline`.

**Tests: 105 backend (was 35 fake ones) + 52 frontend. Backend lint clean, backend
`npm audit`: 0 vulnerabilities. Frontend builds. Server boots and serves.**

---

## ⚠ Read this first — the preconditions were NOT met

Your prompt said to confirm four things before touching code, and to stop if they
weren't done. I checked; none were. You chose to proceed with the code fixes anyway,
which is what this report covers. **The following are still outstanding and no code
change here substitutes for them:**

| Precondition | Actual state (verified today) |
|---|---|
| Anthropic key revoked | Unverifiable from here — **check the console** |
| Secrets rotated | **NOT rotated.** `whatsapp-backend/.env` is byte-identical to the audit: `JWT_SECRET` still starts `dB15ltjnhkni`, `TWILIO_AUTH_TOKEN` still `88b2d0784548` |
| GitHub secret scanning on | No secret-scanning step in CI; repo visibility unverifiable (API returned "Not Found", so it is private or the token lacks access) |
| Collaborators warned | Not done — Phase 0 not run |

`git show e5859b1:.env` still returns the leaked Anthropic key and
`VERIFY_TOKEN=raigam_webhook_2026`, and `git branch -r --contains e5859b1` still
lists `origin/main`, `origin/HEAD`, `origin/phase12-final-qa`,
`origin/refactor/code-quality` and `origin/copilot/fix-deploy-to-vm-job`.

**While the old `JWT_SECRET` is valid, an attacker can mint a `role:'admin'` token
and every access control below is bypassed.** Rotation is the highest-value action
remaining, and it is not something I can do.

---

## Phase 0 — Git history: **NOT RUN** (by instruction)

Your prompt said not to run this without explicit go-ahead separate from the prompt
itself. I did not. Still required: `git filter-repo --path .env --invert-paths`,
force-push the five affected branches, collaborators re-clone. Note that if the repo
is or ever was public, or a fork exists, GitHub keeps the blobs regardless and
**rotation is the only real remedy**.

I did *not* add the gitleaks/trufflehog CI step either — it belongs in the same
commit as the history purge, and adding a scanner that immediately fails on the
history still present would just break your build.

## Phase 1 — Critical routes: **fixed + verified**

| Route | Before | After |
|---|---|---|
| `GET /api/customers` | no gate, unbounded `SELECT *` | `admin`/`viewer`/`sales_agent`, `LIMIT/OFFSET` clamped 1–200 |
| `GET /api/customers/:id` | no gate — **returned the full WhatsApp transcript** | `PIPELINE_READ_ROLES`, matching `/api/messages` exactly |
| `GET /api/orders` | no gate | `STAFF_ROLES` — explicit (see correction below) |
| `GET /api/orders/:id` | no gate | `STAFF_ROLES` — explicit |
| `GET /api/products` | no gate | `STAFF_ROLES` — explicit, catalog is not sensitive |

Ungated `/api` routes went **10 → 2**. The two remaining are correct: `/api/auth/me`
(caller's own claims) and `/api/events` (SSE, IDs only).

**I overruled the audit here.** It recommended gating orders to
`admin/finance/sales_agent/viewer`. That would have **broken production**: I checked
the callers first, and `/orders` is `delivery_coordinator`'s landing page (`App.jsx`
has no `roles` prop on it), `Sidebar.jsx` shows it to them, and `OrdersPage.jsx`
routes that role to `/orders/:id/delivery` on row click, which then fetches
`/api/orders/:id`. Both routes are now gated to all six roles — authenticated-only,
but explicit and commented rather than accidental. Tests lock that access in so
nobody "hardens" it away later.

`GET /api/customers-directory` is **still needed** — it is the stricter, fewer-column
route the Customers page uses. The two are not duplicates any more now that
`/api/customers` is gated and bounded.

## Phase 2 — High: **all fixed + verified**

1. **`advance_required`** — per your explicit decision, `sales_agent` **keeps** it. I
   flagged it as a payment-split bypass; you decided counter advances are the real
   workflow. Implemented as decided, with a comment recording *why* it is intentional
   and what the tradeoff is, so it no longer reads as the oversight the audit called it.
2. **Meta webhook signature** — `POST /webhook` had none; it fed attacker input into
   `processIncomingMessage`, creating customers, inserting messages and **calling the
   paid Claude API**. Now HMAC-SHA256 over the raw body (`express.json` `verify` hook)
   with `timingSafeEqual`, length-checked first. **Fails closed** when
   `META_APP_SECRET` is unset — correct here, since Meta is unconfigured and Twilio is
   the live channel. `TWILIO_VALIDATE_SIGNATURE=false` now only works outside production.
3. **Session revocation** — `authenticate` re-reads `staff_users` every request; the
   **DB role wins over the JWT claim**. Deactivation and demotion now take effect
   immediately instead of after up to 12h. DB outage during auth → 503, not fail-open.
4. **Password policy** — one validator (12 chars, deny-list, no repeated-char) on
   *both* paths. Creation previously enforced **nothing**; reset required 6.
5. **Account lockout** (migration 035) — 5 consecutive failures → 15-minute lock, per
   account. Two details worth knowing: a locked account is refused **before**
   `bcrypt.compare`, so a lock can't be found by timing; and all four failure modes
   return an identical `Invalid credentials`, so the endpoint can't enumerate staff
   phone numbers.
6. **Raw DB errors** — 71 endpoints fixed. Done line-precisely, not by find-replace:
   **all 6 `err.code === '23505'/'23503'` pre-checks survive and still return 409**,
   with a test asserting it. 5 sites deliberately keep `err.message` — those carry
   Twilio/Meta delivery errors (63016 etc.) that staff need.

## Phase 3 — Medium: **all fixed + verified**

1. **Delivery auto-payment is COD-only.** It fired on *every* order, so a card-prepaid
   or disputed order marked delivered was silently recorded as fully collected in cash,
   in the coordinator's name.
2. **Order customer identity gated** to `admin`/`sales_agent`. This matters more than
   attribution: `orders.customer_phone` is where the confirmation and receipt are
   **sent**, so an edit redirects a customer's messages.
3. **Audit log** (migration 036) — append-only, written on login success/failure/
   lockout, every 403, and unknown-field rejections. Deliberately **not** FK'd to
   `staff_users`: the most interesting rows are unauthenticated or since-deleted actors,
   which an FK would reject or cascade away.
4. **`POSTGRES_PASSWORD` fails closed** — both `:-crm_secret` fallbacks replaced with
   `:?`. That default is published in your git history.
5. **Dependencies — backend 3 moderate → 0.** `npm audit fix` alone couldn't do it: it
   patched `body-parser` but left `qs` at 6.15.2 while still claiming a fix was
   available. Rather than `--force` into Express 5, I checked — `qs@6.15.3` is
   published *and* inside Express 4.22.2's own `~6.15.1` range. Added an override,
   cleared the stale lockfile entries, resolved to 6.16.0, verified the app still works.
6. **SSE token scoped** to `/api/events` only. It was accepted on every route, putting
   a 12h admin-capable token into access logs, browser history and `Referer`.

## Phase 4 — Low: **fixed**

- JWT algorithm pinned to `HS256`. (Tested during the audit: `jsonwebtoken@9` already
  rejects `alg:none`, so this is hardening, not a live hole.)
- **nginx was dropping all four security headers on every asset** — `add_header` is not
  inherited into a `location` that declares its own, and the static block sets
  `Cache-Control`. Repeated there, with sync comments both sides.
- HSTS added (1 year, includeSubDomains; **no `preload`** — that's a one-way submission).
- CSP added. Three allowances are load-bearing and were verified against source, not
  guessed: `img-src res.cloudinary.com` (the brand logos), `frame-src blob:` (the PDF
  preview iframe), `style-src 'unsafe-inline'` (53 inline style objects — removing it
  unstyles the whole UI). **Validated with the real nginx binary**: "syntax is ok, test
  is successful".
- Dockerfile: documented that build ARGs persist in image layers and a secret-bearing
  `VITE_*` must never be added; recorded why the nginx stage isn't fully rootless
  (workers already drop to `nginx`; going further changes the port, compose mapping and
  healthcheck).

## Phase 5 — DB least privilege: **NEW CRITICAL-CLASS FINDING**, migration ready, **not switched**

Not in the audit — found by actually checking the grants:

```
\du  →  crm | Superuser, Create role, Create DB, Replication, Bypass RLS
```

The app connects as a **superuser** that also owns all 20 tables. Any backend
compromise becomes control of the database *server*: `DROP TABLE`, reading every other
database on the instance, and `COPY ... FROM PROGRAM` — **shell execution as the
postgres OS user**.

Migration 037 creates `nidikumba_app` (DML + sequences + function EXECUTE; no DDL, no
ownership, no superuser). **Verified on a clone of the real schema** (`pg_dump
--schema-only`: 20 tables, 13 views, 48 functions, 0 errors):

- **Blocked 8/8**: `DROP TABLE`, `ALTER TABLE`, `CREATE TABLE`, `TRUNCATE`,
  `DROP VIEW`, `CREATE ROLE`, `COPY TO PROGRAM`, `ALTER ... OWNER`
- **Worked 6/6**: customer INSERT/UPDATE/DELETE, view SELECT,
  `validate_promo_code` EXECUTE, and a trigger-firing lead INSERT that correctly set
  `follow_up_1_date` via `trg_new_lead_assignment`

The trigger case is the one a naive grant breaks quietly, so it was tested explicitly.
Throwaway DB and role dropped; production verified untouched (20 tables, 8 customers,
11 orders).

**Deliberately not switched.** Creating the role is safe; repointing `DATABASE_URL`
needs a real password and a restart, so it is a separate deliberate step. Run
`migrations/037_verify.sql` against the live DB afterwards.

Incidental finding: `db/init.sql` alone builds only **16 of 20** tables — `staff_users`
and the `bulk_message_*` tables come from later migrations, so it is not a complete
schema on its own.

## Phase 6 — Request validation: **fixed + verified**

The allowlists already prevented mass assignment at the DB layer. The gap was the
*failure mode*: an unknown key was silently **dropped**, so `{"name":"x","role":"admin"}`
returned 200 and a caller could reasonably believe the role was set. Now 400s naming
the field, and audit-logs the attempt. Wired into 5 PATCH routes (staff, customers,
campaigns, influencers, service-tickets).

No schema library added — zod/joi means a new dependency and rewriting ten working
handlers, and each route's `allowed` array already *is* the schema. Also added length
bounds (Postgres `TEXT` has none): 200 chars for names/phones/codes, 2000 for free text.

Mass-assignment test result: `{"name":"x","role":"admin","isAdmin":true}` → **400**,
not a silent drop.

## Phase 7 — Response minimization: **fixed + verified**

`GET /api/orders[/:id]` returned `o.*`, so `delivery_coordinator` got `amount_paid`,
`advance_required`, `is_custom_order`, `notes` and `lead_id` — while 403'd from the
invoice and ledger showing the same figures. Those five are now stripped for that role
only. Chosen by listing the fields their two screens actually render, so nothing
visible changes. `total_amount`/`payment_status` deliberately **kept** — a COD driver
must know what to collect.

## Phase 8 — Log hygiene: **confirmed clean**

Grepped every `console.*` added this session for `req.body`/`password`/`token`/
`authorization`/`password_hash` — the single hit is a route *name* in an error label.
Verified the audit redaction empirically: `password`, `api_key`, `authToken`,
`password_hash`, `Authorization` → `[redacted]`, while diagnostic context
(`reason: bad_password`) survives.

## Phase 9 — Final audit vs. the Sept 10 baseline

| | Sept 10 | Now |
|---|---|---|
| Backend | 3 moderate (`qs`) | **0 vulnerabilities** |
| Frontend | 5 (4 mod, 1 high) | 5 (4 mod, 1 high) — **unchanged by design** |

Frontend untouched per the report's own reachability analysis: `xlsx` has no fix, and
both advisories need spreadsheet **parsing** (this app only writes — CI's hard gate on
`XLSX.read` still returns nothing, re-verified). `vitest` is dev-only.

---

## Deferred — needs a decision from Dilsara

**No per-record ownership model.** Authorization is one-dimensional (role). Any
`sales_agent` can read and edit any other agent's records. `callVisibilityFilter`
covers only 2 routes and is bypassed by siblings. This is a business-rules question —
*should staff see only their own assigned records?* — not a patch, so no code was
written. Affected routes:

- `GET /api/leads` (2528), `GET /api/leads/:id` (2556) — the only two the filter covers
- `GET /api/calls` (1456) — dumps the same call data unfiltered
- `GET /api/leads/:id/items` (2633), `POST/PATCH/DELETE .../items` (2647/2696/2738)
- `PATCH /api/leads/:id` (2750) — edit/close another agent's lead
- `POST /api/leads/:id/quotation` (2584) — claim a quotation number on one
- All order routes — orders have no assigned-staff concept at all

If you want this, the cheapest coherent version is: filter on
`leads.assigned_staff_id` (the column already exists) for `sales_agent`, leave
admin/viewer unrestricted, and decide separately whether orders need an owner column.

## Anything not fixed / ambiguous

1. **Secret rotation and the git-history purge** — outstanding, and the most important
   items on this list. See the top of this report.
2. **Migrations 035, 036, 037 are not applied.** The server boots and warns which are
   missing (verified: it logs both and serves `/health` fine), so lockout and audit
   logging are inert until you run them. Back up first, per repo convention.
3. **`delivery_coordinator` still writes a ledger row** on a COD delivery — narrowed
   from "any order" to COD only, which is the legitimate case. Removing it entirely
   would make COD deliveries impossible for that role.
4. **CI lint stays non-blocking** (`continue-on-error: true`). Making it blocking is a
   separate decision.
5. **Frontend has no test coverage** on the 5 largest files, so frontend-adjacent
   changes (nginx CSP especially) are verified by build + config validation, not by
   tests exercising the UI. **Worth a manual pass on: the Login page logo, the Sidebar
   logo, and an invoice PDF preview** — those are what the CSP would break if I got an
   allowance wrong.
6. **`whatsapp-backend/.env` remains plaintext on this workstation.** Moving it to a
   host secret store is infrastructure work outside this repo.
