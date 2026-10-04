-- depends: 010_settlement_invoice
-- تحذير قبل التشغيل (مرة واحدة): كانت فاتورة kind='disbursement' القديمة «إيصال صرف» يزيد الدين،
-- وصارت بعد 010 تخصم منه. إن وُجدت سجلات قديمة فالأرصدة تغيّرت بأثر رجعي:
--   select count(*), sum(total), min(created_at), max(created_at) from invoices where kind='disbursement';
-- ولتحويل السجلات القديمة إلى فواتير دين (بعد مراجعتها):
--   update invoices set kind='invoice', note=trim(coalesce(note,'')||' [إيصال صرف سابق]') where kind='disbursement' and created_at < 'YYYY-MM-DD';

create or replace function public.create_debt_invoice(p_customer uuid,p_amount numeric,p_note text,p_kind text default 'invoice')
returns bigint language plpgsql security definer set search_path = public as $$
declare v_limit numeric; v_debt numeric; v_id bigint; v_amt numeric;
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if p_kind not in ('invoice','disbursement') then raise exception 'نوع غير صحيح'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000 then raise exception 'القيمة غير صحيحة'; end if;
  v_amt := round(p_amount,2);
  if v_amt <= 0 then raise exception 'القيمة غير صحيحة'; end if;
  select credit_limit into v_limit from public.customers where id=p_customer for update;
  if not found then raise exception 'العميل غير موجود'; end if;
  select debt into v_debt from public.customer_balances where id=p_customer;
  if p_kind = 'invoice' then
    if v_limit > 0 and v_debt + v_amt > v_limit then raise exception 'يتجاوز حد الائتمان'; end if;
  elsif v_amt > v_debt then
    raise exception 'مبلغ السداد أكبر من الدين الحالي (%)', v_debt;   -- مثل add_payment
  end if;
  insert into public.invoices(customer_id,total,paid,note,kind)
  values(p_customer,v_amt,0,nullif(trim(p_note),''),p_kind)
  returning id into v_id;
  return v_id;
end $$;

-- «اليوم» بتوقيت منطقتك لا UTC (غيّر 'Africa/Tripoli' عند الحاجة)
create or replace view public.store_stats with (security_invoker=true) as
with d as (select date_trunc('day', now() at time zone 'Africa/Tripoli') at time zone 'Africa/Tripoli' as s)
select
  (select count(*) from public.customers) as customers_count,
  (select coalesce(sum(debt),0) from public.customer_balances) as total_debt,
  (select coalesce(sum(total),0) from public.invoices where kind='invoice' and voided_at is null) as total_invoiced,
  (select coalesce(sum(total),0) from public.invoices where kind='disbursement' and voided_at is null) as total_disbursed,
  (select coalesce(sum(amount),0) from public.payments where voided_at is null) as total_paid,
  ((select coalesce(sum(total),0) from public.invoices where kind='invoice' and voided_at is null and created_at >= d.s)
   - (select coalesce(sum(total),0) from public.invoices where kind='disbursement' and voided_at is null and created_at >= d.s)
   - (select coalesce(sum(amount),0) from public.payments where voided_at is null and created_at >= d.s)) as today_debt,
  (select coalesce(sum(amount),0) from public.payments where voided_at is null and created_at >= d.s) as today_paid
from d;

grant select on public.store_stats to authenticated;
