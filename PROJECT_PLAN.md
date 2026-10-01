# NIDIKUMBA CRM Upgrade — Project Plan for Claude Code

This plan turns `NIDIKUMBA_Requirements_Specification.pdf` (v2.0) into an executable sequence.
The PDF is the source of truth for **what** to build (exact schema, SQL, requirement IDs).
This plan governs **when** and **how** — one phase per Claude Code session, tested before moving on.

## How to work through this with Claude Code

- **One phase per session.** Don't ask Claude Code to "build the whole spec" — scope each session to one phase below.
- **One git branch per phase**, merged back to `develop` only after the verification step passes.
- **Back up the database before every migration**, no exceptions: `pg_dump nidikumba_db > backup_$(date +%Y%m%d_%H%M).sql`
- **Point Claude Code at the PDF or the relevant Appendix A section** at the start of each session — paste the exact SQL/requirements block in, don't make it re-derive the schema from memory.
- **Review every migration diff yourself** before it touches the real database. Claude Code is very good at writing correct SQL from a spec; it can't know if your production data already violates a constraint you're about to add (the `orders.status` mismatch found earlier is exactly this kind of surprise).
- Drop the accompanying `CLAUDE.md` into your repo root once — it gives every future session this same context automatically.

---

## Phase 0 — Setup (once, before Phase 1)

**Goal:** safe foundation for everything else.

- [ ] Add `CLAUDE.md` (provided separately) to repo root
- [ ] Create a `migrations/` folder if one doesn't exist — one numbered `.sql` file per phase (`001_staff_roles.sql`, `002_ticket_foundation.sql`, ...)
- [ ] Full `pg_dump` backup, stored somewhere outside the server
- [ ] Create a `develop` branch; every phase branches from it, merges back after testing
- [ ] Confirm you have a way to test against a copy of real data, not just an empty schema — several requirements (order status, `items` shape) only matter once real rows exist

---

## Phase 1 — Staff Roles & Access Control (Module 2)

**Why first:** every other module needs to know who's asking before it can enforce anything.
**Depends on:** Phase 0 only.

**⚠️ Architecture correction before you start:** the original spec assumed Supabase (Row Level Security tied to Supabase Auth's `auth.uid()`). The real stack is self-hosted Postgres with no Supabase Auth layer. RLS itself still works fine on self-hosted Postgres — but there's no automatic JWT-to-`auth.uid()` bridge. Two honest options:
1. **Simpler, recommended for your scale:** enforce roles in Express middleware (`requireRole(['admin','sales_agent'])` on each route) backed by your own session/JWT auth. No RLS needed yet.
2. **More robust, more setup:** implement RLS policies plus a `SET app.current_user_id` pattern per request. Only worth it once you have real risk of a compromised route bypassing the app layer.

Start with option 1.

**Claude Code kickoff prompt:**
> "Add a `staff_users` table (id, name, phone, role, active) with the six roles from Section 5.1 of the spec. Add session-based or JWT auth (your choice, keep it simple) and an Express middleware `requireRole(roles)` that checks the logged-in user's role before allowing a route to proceed. Apply this middleware to every existing route that touches orders, customers, or payments. Write a migration file, not a direct ALTER."

**Verify:** log in as two different roles, confirm a Sales-Agent-only account gets a 403 hitting a Finance-only route.

---

## Phase 2 — Lead Scoring Prompt Formalization (Module 1)

**Why now:** lowest risk, fastest visible improvement — pure prompt engineering on code that already works, no schema changes.
**Depends on:** nothing. Can actually run in parallel with Phase 1 if you want a quick win first.

**Claude Code kickoff prompt:**
> "Find the Claude classification call in `analyzeConversation()`. Rewrite its system prompt to use the explicit Low/Medium/High criteria in Section 4.2 of the spec, instead of whatever free-text instruction is there now. Don't change the surrounding code, table writes, or response format — only the classification criteria in the prompt text itself."

**Verify:** send 3 test conversations (obvious high-intent, obvious browsing, ambiguous) and confirm the labels match the documented criteria consistently, not just plausibly.

---

## Phase 3 — Ticket Foundation (Leads + Orders linkage)

**Why now:** this is the load-bearing schema change everything from Phase 5 onward depends on.
**Depends on:** Phase 1 (roles must exist to restrict who can close/reopen tickets later).

**Claude Code kickoff prompt:**
> "Apply the migration from Appendix A.2 of the spec: add `ticket_state`, `closed_at`, `closed_reason`, `is_returning_contact`, `reopened_from_lead_id` to `leads`; add `lead_id` and `amount_paid` to `orders`; add the corrected `orders_status_check` constraint using the six real status values (new/confirmed/processing/shipped/delivered/cancelled) — do NOT use the nine-value version, it doesn't match production. Add the `orders_delivered_requires_paid` constraint. Then implement Trigger 1 (`handle_order_completed`) from Appendix A.3 exactly as written — checks `status='delivered' AND payment_status='paid'`."

**Verify:** manually move a test order to `delivered` + `paid` in a transaction you roll back — confirm the linked lead closes and `customers.is_loyalty_customer` flips, without committing it to real data yet.

---

## Phase 4 — Order Lifecycle Completion (Module 3 remainder)

**Depends on:** Phase 3.

**Claude Code kickoff prompt:**
> "Add the inventory table and reorder-alert logic from Section 6.3, and delivery scheduling fields from Section 6.4 (date, time slot, driver, delivery confirmation note). Wire stock reservation to fire when an order reaches `confirmed` status, per REQ-3.7."

**Verify:** confirm an order, watch stock decrement; cancel a different confirmed order, watch its reservation release.

---

## Phase 5 — Assignment, SLA & Staff Accountability (Module 4 core)

**Depends on:** Phase 1 (staff_users), Phase 3 (ticket_state).

**Claude Code kickoff prompt:**
> "Implement the assignment and SLA logic from Section 7.1–7.4: auto-assign new tickets round-robin weighted by open-lead count, start an SLA countdown per the thresholds in 7.2 (now High/Medium/Low, not Hot/Warm/Cold), mark overdue automatically, and build the staff performance dashboard queries from 7.4."

**Verify:** create a test ticket, don't touch it, confirm it flips to overdue and alerts after the SLA window — don't wait for the real window in testing, temporarily shrink it to minutes.

---

## Phase 6 — Dialog Call Integration (Module 4 addition)

**Depends on:** Phase 5 (reuses the same assignment/SLA engine).

**Claude Code kickoff prompt:**
> "Add the `call_events` table and webhook route from Appendix A (Section 7.5), and Trigger logic so a missed call (zero duration) creates a ticket through the same assignment path as a new WhatsApp lead, per REQ-4.14."

**Verify:** send a test payload matching Dialog's real webhook shape (get a sample from Dialog's docs or a real logged call) and confirm a ticket + assignment appears.

---

## Phase 7 — Post-Purchase Retention & Promotions (Module 5)

**Depends on:** Phase 3 (loyalty flag lives on the ticket-close trigger already built).

**Claude Code kickoff prompt:**
> "Add the `campaigns` and `campaign_sends` tables from Appendix A, the consent fields on `customers`, and the retention-trigger scheduling from Section 8.2. Make sure REQ-5.7 is enforced in code, not just documented — no send without `consent_for_marketing = true`."

**Verify:** attempt to queue a campaign send to a customer with consent false — confirm it's rejected, not just skipped silently.

---

## Phase 8 — Automated Reply Polish (Module 6 remainder)

**Depends on:** nothing structurally, but do this after the schema work so you're not context-switching between DB migrations and prompt/formatting work.

**Claude Code kickoff prompt:**
> "The ai_enabled gating and staff-reply handoff already work (confirmed live). Add what's missing from Section 9: markdown-to-WhatsApp formatting, message chunking with paced delays (9.1), the explicit tone/persona rules (9.2), and — this is the real gap — add `tools` to the Claude API call so `escalate_to_human` can actually fire per REQ-6.8/6.9. Right now there is no tool-calling plumbing at all; this needs the Claude SDK's tool-use parameter added, not just a prompt instruction."

**Verify:** trigger a message designed to escalate (customer asks for a human explicitly) and confirm the tool actually fires and `ai_enabled` flips — not just that the reply text sounds like it's escalating.

---

## Phase 9 — Promo Codes & Influencer Tracking

**Depends on:** Phase 3 (orders.lead_id) and Phase 4 (orders complete).

**Claude Code kickoff prompt:**
> "Implement the promo code system as discussed: `promo_codes`, `promo_code_redemptions` tables, the `validate_promo_code` and `redeem_promo_code` functions (with row-level locking), and the `/api/promo-codes/validate` and `/redeem` endpoints for the website integration. Add the Claude tool definition for `apply_promo_code` to the WhatsApp reply flow."

**Verify:** have two requests attempt to redeem the last available use of a capped code at the same time (script this, don't rely on manual timing) — confirm only one succeeds.

---

## Phase 10 — Warranty & Service Tickets (Module 8)

**Depends on:** Phase 3 (fires off the same order-completion trigger).

**Claude Code kickoff prompt:**
> "Add the `warranties` and `service_tickets` tables and both triggers from Appendix A.7 exactly as written, including the name-based product matching (there's no product_id in order line items yet — matching is by name, which is documented as fragile but is what the schema allows today). Add the `check_warranty_status` tool to the Claude reply flow."

**Verify:** deliver+pay a test order for a product with `warranty_years` set, confirm a warranty row appears with the correct end date; ask the WhatsApp bot about warranty status and confirm it reads the real record.

---

## Phase 11 — Business Intelligence Dashboard (Module 7)

**Depends on:** everything above existing with real data flowing through it — this is pure reporting, build it last.

**Claude Code kickoff prompt:**
> "Add the five views from Appendix A.6 exactly as corrected (delivered+paid, not completed; qty/unit_price, not quantity). Build dashboard pages that query these views. Skip the staff leaderboard view until Phase 1's staff_users and Phase 5's assignment tracking have real data in them."

**Verify:** cross-check one number by hand (e.g., last month's revenue) against `v_revenue_daily` before trusting the dashboard for anything else.

---

## Phase 12 — Final QA & Launch Checklist

- [ ] Every migration has a tested rollback script
- [ ] Every role in Phase 1 tested against every restricted route, not just the obvious ones
- [ ] Load-test the promo code redemption function specifically (Phase 9's concurrency check)
- [ ] Confirm no `'completed'` status string survives anywhere in new code — it should always be `delivered` + `paid`
- [ ] Re-run the same kind of code audit that produced the v2.0 correction — verify what you *actually* built matches what you *intended* to build, the same way the original spec's inaccuracies were caught

---

## Suggested order if you have limited time

If you can't do all 12 phases: **1 → 3 → 5** gets you roles, tickets, and accountability — the "customers stop falling through the cracks" core. Everything else is additive on top of that foundation.
