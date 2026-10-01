-- depends: 005_edit
-- Database timezone must be Africa/Tripoli; now()::date uses the database session timezone.

create or replace view public.store_stats with (security_invoker=true) as
select
  (select count(*) from public.customers) as customers_count,
  (select coalesce(sum(greatest(debt,0)),0) from public.customer_balances) as total_debt,
  (select coalesce(sum(total),0) from public.invoices where kind='invoice' and voided_at is null) as total_invoiced,
  (select coalesce(sum(total),0) from public.invoices where kind='disbursement' and voided_at is null) as total_disbursed,
  (select coalesce(sum(amount),0) from public.payments) as total_paid,
  ((select coalesce(sum(total),0) from public.invoices where voided_at is null and created_at >= now()::date)
   - (select coalesce(sum(amount),0) from public.payments where created_at >= now()::date)) as today_debt,
  (select coalesce(sum(amount),0) from public.payments where created_at >= now()::date) as today_paid;

grant select on public.store_stats to authenticated;
