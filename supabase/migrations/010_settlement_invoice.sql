-- depends: 009_receipt_edit_void
-- disbursement is retained as the historical database kind, but now means a settlement invoice:
-- it reduces the customer's debt, exactly like a payment.

create or replace function public.create_debt_invoice(p_customer uuid,p_amount numeric,p_note text,p_kind text default 'invoice')
returns bigint language plpgsql security definer set search_path = public as $$
declare v_limit numeric; v_debt numeric; v_id bigint;
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if p_kind not in ('invoice','disbursement') then raise exception 'نوع غير صحيح'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'القيمة غير صحيحة'; end if;
  select credit_limit into v_limit from public.customers where id=p_customer for update;
  if not found then raise exception 'العميل غير موجود'; end if;
  if p_kind = 'invoice' then
    select debt into v_debt from public.customer_balances where id=p_customer;
    if v_limit > 0 and v_debt + round(p_amount,2) > v_limit then raise exception 'يتجاوز حد الائتمان'; end if;
  end if;
  insert into public.invoices(customer_id,total,paid,note,kind)
  values(p_customer,round(p_amount,2),0,nullif(trim(p_note),''),p_kind)
  returning id into v_id;
  return v_id;
end $$;

create or replace view public.customer_balances with (security_invoker=true) as
select c.id,c.name,c.phone,
  coalesce((select sum(i.total-i.paid) from public.invoices i where i.customer_id=c.id and i.kind='invoice' and i.voided_at is null),0)
  - coalesce((select sum(i.total) from public.invoices i where i.customer_id=c.id and i.kind='disbursement' and i.voided_at is null),0)
  - coalesce((select sum(p.amount) from public.payments p where p.customer_id=c.id and p.voided_at is null),0) as debt,
  c.credit_limit
from public.customers c;

create or replace view public.store_stats with (security_invoker=true) as
select
  (select count(*) from public.customers) as customers_count,
  (select coalesce(sum(debt),0) from public.customer_balances) as total_debt,
  (select coalesce(sum(total),0) from public.invoices where kind='invoice' and voided_at is null) as total_invoiced,
  (select coalesce(sum(total),0) from public.invoices where kind='disbursement' and voided_at is null) as total_disbursed,
  (select coalesce(sum(amount),0) from public.payments where voided_at is null) as total_paid,
  ((select coalesce(sum(total),0) from public.invoices where kind='invoice' and voided_at is null and created_at >= now()::date)
   - (select coalesce(sum(total),0) from public.invoices where kind='disbursement' and voided_at is null and created_at >= now()::date)
   - (select coalesce(sum(amount),0) from public.payments where voided_at is null and created_at >= now()::date)) as today_debt,
  (select coalesce(sum(amount),0) from public.payments where voided_at is null and created_at >= now()::date) as today_paid;

grant select on public.store_stats to authenticated;
