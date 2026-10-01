-- depends: 005_edit

-- منطقة التوقيت على مستوى القاعدة (تُطبَّق على الاتصالات الجديدة).
-- بهذا يصبح البناء من الصفر ذاتياً بلا خطوة يدوية في اللوحة.
-- غيّر القيمة إن تغيّر موقع المحل.
do $$ begin
  execute 'alter database postgres set timezone to ''Africa/Tripoli''';
exception when others then
  raise notice 'تعذّر ضبط التوقيت تلقائياً (%): اضبطه من Settings → Database → Timezone', sqlerrm;
end $$;

-- now()::date يتبع توقيت جلسة القاعدة، فليست هناك منطقة مضمّنة داخل SQL.
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
