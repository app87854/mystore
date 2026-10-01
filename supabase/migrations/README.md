# Database migrations

Run these files once, in order, on a fresh Supabase project:

1. `001_schema.sql` — base tables, RLS, trigger, and realtime setup.
2. `002_users.sql` — usernames, roles, and username login lookup.
3. `003_debts.sql` — credit limits, debt invoices, and payments.
4. `004_receipts.sql` — invoice/disbursement kinds.
5. `005_edit.sql` — customer editing, safe deletion, voiding, and the final hardened bodies of `create_debt_invoice` / `add_payment` (amount cap, rounding before validation, credit-limit message with figures).
6. `006_stats.sql` — database timezone and the statistics view.

Each migration is intended to be rerunnable. The `-- depends:` header records the required predecessor.

## Required project setting

`006_stats.sql` sets the database timezone to `Africa/Tripoli` in SQL, and `store_stats` uses `now()::date` so it follows that timezone. If the `alter database` step is blocked on your project, set **Settings → Database → Timezone** manually — otherwise the "today" figures are computed in UTC. Change the value in `006_stats.sql` if the shop moves to another timezone.

## Verification

After running all six files, verify:

```sql
-- الدوال موجودة
select routine_name from information_schema.routines
where routine_schema = 'public'
  and routine_name in ('create_debt_invoice','add_payment','void_invoice','rename_customer','delete_customer');

-- الإحصائيات تُقرأ بلا أخطاء
select customers_count,total_debt,total_invoiced,total_disbursed,total_paid,today_debt,today_paid
from public.store_stats limit 1;

-- anon لا يستطيع أي شيء
select has_function_privilege('anon','public.add_payment(uuid,numeric,text)','execute');  -- false

-- المنطقة الزمنية
show timezone;  -- Africa/Tripoli
```
