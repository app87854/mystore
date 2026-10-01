# Database migrations

Run these files once, in order, on a fresh Supabase project:

1. `001_schema.sql` — base tables, RLS, trigger, and realtime setup.
2. `002_users.sql` — usernames, roles, and username login lookup.
3. `003_debts.sql` — credit limits, debt invoices, and payments.
4. `004_receipts.sql` — invoice/disbursement kinds.
5. `005_edit.sql` — customer editing, safe deletion, voiding, and legacy RPC hardening.
6. `006_stats.sql` — statistics view using the database-local date.

Each migration is intended to be rerunnable. The `-- depends:` header records the required predecessor.

## Required project setting

Set the Supabase database timezone to `Africa/Tripoli` in **Settings → Database → Timezone** before using the daily statistics. The `006_stats.sql` view deliberately uses `now()::date`, so it follows the database timezone.

## Verification

After running all six files, verify:

```sql
select routine_name from information_schema.routines
where routine_schema = 'public'
  and routine_name in ('create_debt_invoice','add_payment','void_invoice','rename_customer','delete_customer')
limit 20;

select customers_count,total_debt,total_invoiced,total_disbursed,total_paid,today_debt,today_paid
from public.store_stats limit 1;
```
