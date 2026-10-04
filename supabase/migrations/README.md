# Database migrations

For a fresh Supabase project, apply the migrations in order:

1. `001_schema.sql` — base tables, RLS, triggers, and Realtime setup.
2. `002_users.sql` — usernames, roles, and username login lookup.
3. `003_debts.sql` — credit limits, debt invoices, and payments.
4. `004_receipts.sql` — invoice/disbursement kinds and receipt reporting.
5. `005_edit.sql` — customer editing, safe deletion, voiding, and hardened debt/payment functions.
6. `006_stats.sql` — database timezone and statistics view.
7. `007_seller_void.sql` — seller void operations.
8. `008_invoice_edit.sql` — invoice editing and settlement behavior.
9. `009_receipt_edit_void.sql` — receipt editing/voiding and balance recalculation.
10. `010_settlement_invoice.sql` — settlement invoice semantics.
11. `011_settlement_fixes.sql` — hardened settlement invoice validation and corrected daily statistics, using `Africa/Tripoli` to match `006_stats.sql`.
12. `012_web_push.sql` — optional Web Push subscriptions, private event queue, and event triggers.
13. `013_push_maintenance.sql` — optional daily cleanup; inspect first because it deletes push events and credit alerts older than 30 days.
14. `014_push_webhook_notify.sql` — lower-privilege `pg_net` trigger using Vault secrets and a non-destructive five-minute retry job using `pg_cron`; it does not enable the 013 cleanup.

For an existing project at migration 010, apply 011, 012, then 014. Migration 014 depends directly on 012, so 013 can be omitted. Before applying 011 to an existing database, review its warning about older `disbursement` rows: since migration 010 changed their balance meaning, historical records may require a separately reviewed data correction. Do not run the commented update without verifying affected records and the cutoff date.

Each migration records its predecessor in a `-- depends:` header. On the linked Supabase project, 011 and 012 were applied on 2026-10-03, and 014 was applied on 2026-10-04. Migration 013 remains unapplied to avoid its data-deletion schedule. No historical `disbursement` rows were present during the pre-011 check.

## Required project setting

`006_stats.sql` sets the database timezone to `Africa/Tripoli`, and `store_stats` uses the session timezone for "today" figures. If the `alter database` step is blocked on your project, set **Settings → Database → Timezone** manually. Keep the value aligned with the shop's local timezone.

## Web Push status

The `push-notify` Edge Function and the backend are configured. Its VAPID settings and rotated `PUSH_WEBHOOK_SECRET` are stored in Edge Function secrets; Vault contains `push_function_url` and `push_webhook_secret`. The `push_events_notify` trigger invokes the function via `pg_net`; the `push-events-retry` cron job runs every five minutes. No Database Webhook is used. Delivery to devices is still pending publication of the updated `index.html` and `sw.js`, administrator opt-in on each device, and an end-to-end test.

The retry job processes up to 20 unprocessed events per run, limited to events between two minutes and 24 hours old. No cleanup job is scheduled.
