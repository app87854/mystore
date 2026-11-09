# Database migrations

For a fresh Supabase project, apply migrations `001` through `012` in numerical order, then `014_push_webhook_notify.sql`, `015_security_hardening.sql`, `016_push_all_admins.sql`, `017_customer_number.sql`, `018_allow_overpayment_credit.sql`, `019_fixes.sql`, and `020_revoke_trigger_function_execute.sql`. Migration `013_push_maintenance.sql` is optional and must not be applied without explicit review because it schedules deletion of push events and credit-alert records older than 30 days.

For an existing project at migration 010, the production sequence is 011, 012, 014, 015, 016, 017, 018, 019, and 020. Migration 011 uses `Africa/Tripoli`; review its warning about historical `disbursement` rows before applying it to other databases. No such historical rows were present in the pre-011 production check.

## Production status (2026-11-03)

Migration 018 is applied (2026-10-21). It removes the "payment may not exceed current debt" checks from `add_payment` and from disbursement invoices in `create_debt_invoice`; an overpayment becomes a negative balance in `customer_balances` and is offset by later invoices. Migrations 019 and 020 are pending. Migration 020 revokes `EXECUTE` on the five trigger functions from `public`, `anon`, and `authenticated` (no-op on production, whose ACL already matches; it aligns fresh databases built from 012, 016, and 017 with production). Trigger functions do not need `EXECUTE` for the inserting role, and RPC functions used by the client (for example `save_push_subscription`) are untouched. Migration 019 does the following: it adds the credit-limit check to `update_debt_invoice` (applies only when an edit increases the amount; reducing an invoice is always allowed, even for a customer already over the limit), post-rounding `> 0` checks to `update_debt_invoice` and `update_payment`, a limit/debt message in `create_debt_invoice`, and `credit_check` push events when invoice amounts change or invoices are voided. Re-verify before applying.

## Production status (2026-10-07)

Migrations 011, 012, 014, 015, 016, and 017 are applied. Migration 013 remains unapplied; no cleanup job is scheduled. Migration 014 configures the lower-privilege `pg_net` trigger using Vault and a non-destructive five-minute retry job via `pg_cron`.

`015_security_hardening.sql` revokes API-role execution of `handle_new_user()` and revokes `anon` execution of `is_admin()`; `authenticated` retains execution of `is_admin()` for RLS policies. It changes no application data or business logic.

`016_push_all_admins.sql` queues invoice-created and invoice-voided events for all actors, including administrators. Deploy the updated `push-notify` function before 016; production now runs the updated function. Credit-check event logic is unchanged.

`017_customer_number.sql` backfills `customer_no` from 1 in `created_at,id` order, adds a unique/not-null integer, and assigns future numbers in a `BEFORE INSERT` trigger that overwrites client input. A separate `BEFORE UPDATE` trigger prevents changes. The trigger is the single numbering source, so the column intentionally has no `DEFAULT`; the sequence and trigger functions are not executable/usable by `public`, `anon`, or `authenticated`. `customer_balances` appends `customer_no` as its final column while preserving `security_invoker=true`, owner, and existing grants; `store_stats` remains functional. The migration and insert/update behavior were validated in a rolled-back transaction before application.

The PWA is hosted at https://app87854.github.io/mystore/. Admins must opt in to notifications on each device. Notification text identifies the actor and invoice type only; it omits customer names and amounts. Keep `VAPID_PRIVATE_KEY` and `PUSH_WEBHOOK_SECRET` in server-side secrets only.

The retry job processes at most 20 unprocessed events between two minutes and 24 hours old. The push retry/delete behavior for expired subscriptions remains enabled; no data-retention cleanup job is scheduled.
