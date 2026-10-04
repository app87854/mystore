# Database migrations

For a fresh Supabase project, apply migrations `001` through `012` in numerical order, then `014_push_webhook_notify.sql`, `015_security_hardening.sql`, and `016_push_all_admins.sql`. Migration `013_push_maintenance.sql` is optional and must not be applied without explicit review because it schedules deletion of push events and credit-alert records older than 30 days.

For an existing project at migration 010, the production sequence was 011, 012, 014, 015, and 016. Migration 011 uses `Africa/Tripoli`; review its warning about historical `disbursement` rows before applying it to other databases. No such historical rows were present in the pre-011 production check.

## Production status (2026-10-04)

Migrations 011, 012, 014, 015, and 016 are applied. Migration 013 remains unapplied; no cleanup job is scheduled. Migration 014 configures the lower-privilege `pg_net` trigger using Vault and a non-destructive five-minute retry job via `pg_cron`.

`015_security_hardening.sql` revokes API-role execution of `handle_new_user()` and revokes `anon` execution of `is_admin()`; `authenticated` retains execution of `is_admin()` for RLS policies. It changes no application data or business logic.

`016_push_all_admins.sql` queues invoice-created and invoice-voided events for all actors, including administrators. Deploy the updated `push-notify` function before 016; production now runs the updated function. Credit-check event logic is unchanged.

The PWA is hosted at https://app87854.github.io/mystore/. Admins must opt in to notifications on each device. Notification text identifies the actor and invoice type only; it omits customer names and amounts. Keep `VAPID_PRIVATE_KEY` and `PUSH_WEBHOOK_SECRET` in server-side secrets only.

The retry job processes at most 20 unprocessed events between two minutes and 24 hours old. The push retry/delete behavior for expired subscriptions remains enabled; no data-retention cleanup job is scheduled.
