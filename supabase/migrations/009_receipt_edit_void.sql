-- depends: 008_invoice_edit
-- Negative customer balances represent customer credit/surplus.

alter table public.invoices add column if not exists edited_at timestamptz;
alter table public.invoices add column if not exists edited_by uuid references public.profiles(id);
alter table public.payments add column if not exists voided_at timestamptz;
alter table public.payments add column if not exists voided_by uuid references public.profiles(id);
alter table public.payments add column if not exists void_reason text;
alter table public.payments add column if not exists edited_at timestamptz;
alter table public.payments add column if not exists edited_by uuid references public.profiles(id);

create index if not exists invoices_customer_id_idx on public.invoices(customer_id);
create index if not exists payments_customer_id_idx on public.payments(customer_id);

create or replace view public.customer_balances with (security_invoker=true) as
select c.id,c.name,c.phone,
  coalesce((select sum(i.total-i.paid) from public.invoices i where i.customer_id=c.id and i.voided_at is null),0)
  - coalesce((select sum(p.amount) from public.payments p where p.customer_id=c.id and p.voided_at is null),0) as debt,
  c.credit_limit
from public.customers c;

create or replace function public.update_debt_invoice(p_id bigint, p_amount numeric, p_note text)
returns void language plpgsql security definer set search_path=public as $$
declare v_amt numeric; v_cust uuid;
begin
  if auth.uid() is null or not is_admin() then raise exception 'المدير فقط'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000 then raise exception 'القيمة غير صحيحة'; end if;
  v_amt := round(p_amount, 2);
  select customer_id into v_cust from public.invoices where id=p_id for update;
  if not found then raise exception 'الفاتورة غير موجودة'; end if;
  if exists(select 1 from public.invoice_items where invoice_id=p_id) then raise exception 'فاتورة مبيعات مخزنية: لا تعدل من هنا'; end if;
  perform 1 from public.customers where id=v_cust for update;
  if exists(select 1 from public.invoices where id=p_id and voided_at is not null) then raise exception 'الفاتورة ملغاة'; end if;
  update public.invoices set total=v_amt, note=nullif(trim(p_note),''), edited_at=now(), edited_by=auth.uid() where id=p_id;
end $$;

create or replace function public.void_invoice(p_id bigint,p_reason text default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_cust uuid; v_void timestamptz;
begin
  if auth.uid() is null then raise exception 'غير مصرح'; end if;
  select customer_id into v_cust from public.invoices where id=p_id;
  if not found then raise exception 'الفاتورة غير موجودة'; end if;
  if exists(select 1 from public.invoice_items where invoice_id=p_id) then raise exception 'فاتورة مبيعات مخزنية: لا تلغى من هنا'; end if;
  perform 1 from public.customers where id=v_cust for update;
  select voided_at into v_void from public.invoices where id=p_id for update;
  if v_void is not null then raise exception 'الفاتورة ملغاة مسبقاً'; end if;
  update public.invoices set voided_at=now(),voided_by=auth.uid(),void_reason=nullif(trim(p_reason),'') where id=p_id;
end $$;

create or replace function public.update_payment(p_id bigint, p_amount numeric, p_note text)
returns void language plpgsql security definer set search_path=public as $$
declare v_amt numeric; v_cust uuid;
begin
  if auth.uid() is null or not is_admin() then raise exception 'المدير فقط'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000 then raise exception 'مبلغ غير صحيح'; end if;
  v_amt := round(p_amount, 2);
  select customer_id into v_cust from public.payments where id=p_id for update;
  if not found then raise exception 'التسديد غير موجود'; end if;
  perform 1 from public.customers where id=v_cust for update;
  if exists(select 1 from public.payments where id=p_id and voided_at is not null) then raise exception 'التسديد ملغى'; end if;
  update public.payments set amount=v_amt, note=nullif(trim(p_note),''), edited_at=now(), edited_by=auth.uid() where id=p_id;
end $$;

create or replace function public.void_payment(p_id bigint,p_reason text default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_cust uuid; v_void timestamptz;
begin
  if auth.uid() is null then raise exception 'غير مصرح'; end if;
  select customer_id into v_cust from public.payments where id=p_id;
  if not found then raise exception 'التسديد غير موجود'; end if;
  perform 1 from public.customers where id=v_cust for update;
  select voided_at into v_void from public.payments where id=p_id for update;
  if v_void is not null then raise exception 'التسديد ملغى مسبقاً'; end if;
  update public.payments set voided_at=now(),voided_by=auth.uid(),void_reason=nullif(trim(p_reason),'') where id=p_id;
end $$;

revoke execute on function public.update_payment(bigint,numeric,text), public.void_payment(bigint,text) from public, anon;
grant execute on function public.update_payment(bigint,numeric,text), public.void_payment(bigint,text) to authenticated;

create or replace view public.store_stats with (security_invoker=true) as
select
  (select count(*) from public.customers) as customers_count,
  (select coalesce(sum(debt),0) from public.customer_balances) as total_debt,
  (select coalesce(sum(total),0) from public.invoices where kind='invoice' and voided_at is null) as total_invoiced,
  (select coalesce(sum(total),0) from public.invoices where kind='disbursement' and voided_at is null) as total_disbursed,
  (select coalesce(sum(amount),0) from public.payments where voided_at is null) as total_paid,
  ((select coalesce(sum(total),0) from public.invoices where voided_at is null and created_at >= now()::date)
   - (select coalesce(sum(amount),0) from public.payments where voided_at is null and created_at >= now()::date)) as today_debt,
  (select coalesce(sum(amount),0) from public.payments where voided_at is null and created_at >= now()::date) as today_paid;

grant select on public.store_stats to authenticated;
