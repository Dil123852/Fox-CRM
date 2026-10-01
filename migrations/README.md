# Migrations

One numbered `.sql` file per phase of `PROJECT_PLAN.md`, e.g. `001_staff_roles.sql`, `002_ticket_foundation.sql`.

Rules (see `CLAUDE.md` for the full context these enforce):

- Never run a direct `ALTER`/`CREATE` against the database without a file here recording it.
- Take a `pg_dump` backup before applying any file in this folder (see `backups/`, git-ignored).
- Any migration touching `orders.status` must use the real six-value vocabulary: `new`, `confirmed`, `processing`, `shipped`, `delivered`, `cancelled`. Do not introduce `completed`, `ready_for_delivery`, or `out_for_delivery` — they don't exist in production and nothing reads them.
- "Completed" everywhere in this project means `status = 'delivered' AND payment_status = 'paid'`, not a status value.

This folder is distinct from `db/migrations/` (the two pre-existing migrations that shaped the current live schema: `001_add_channel_to_customers.sql`, `002_add_products.sql`, already folded into `db/init.sql`). New work from `PROJECT_PLAN.md` starts numbering fresh here.

## Rollbacks

Every `NNN_name.sql` has a matching `NNN_name.down.sql` (Phase 12). Apply forward
in ascending order; roll back in **descending** order — each down script only
undoes its own migration and assumes every later one has already been rolled
back (e.g. `004`'s down drops `leads.assigned_staff_id`'s FK before `001`'s down
tries to drop `staff_users`).

Tested end-to-end on a throwaway container: fresh install → 001..009 forward →
schema matched (14 tables, 9 views) → 009..001 down → schema returned to the
exact original 5 tables, column-for-column → 001..009 forward again with zero
errors. `005`'s down script has one known sharp edge: it re-narrows
`customers.channel` back to `('meta','twilio')`, which will fail loudly (not
silently) if any `channel='call'` row exists from the Dialog trigger — decide
what to do with those rows before rolling back that far.

