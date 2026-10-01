-- depends: 004_receipts

alter table public.invoices add column if not exists voided_at timestamptz;
alter table public.invoices add column if not exists voided_by uuid;
alter table public.invoices add column if not exists void_reason text;
create or replace view public.customer_balances with (security_invoker=true) as
select c.id,c.name,c.phone,
  coalesce((select sum(i.total-i.paid) from public.invoices i where i.customer_id=c.id and i.voided_at is null),0)
  - coalesce((select sum(p.amount) from public.payments p where p.customer_id=c.id),0) as debt,c.credit_limit
from public.customers c;

create or replace function public.void_invoice(p_id bigint,p_reason text default null) returns void language plpgsql security definer set search_path=public as $$
declare v_cust uuid; v_void timestamptz;
begin
  if auth.uid() is null or not is_admin() then raise exception 'المدير فقط'; end if;
  select customer_id into v_cust from public.invoices where id=p_id; if not found then raise exception 'الفاتورة غير موجودة'; end if;
  if exists(select 1 from public.invoice_items where invoice_id=p_id) then raise exception 'فاتورة مبيعات مخزنية: لا تُلغى من هنا'; end if;
  if v_cust is not null then perform 1 from public.customers where id=v_cust for update; end if;
  select voided_at into v_void from public.invoices where id=p_id for update; if v_void is not null then raise exception 'الفاتورة ملغاة مسبقاً'; end if;
  update public.invoices set voided_at=now(),voided_by=auth.uid(),void_reason=nullif(trim(p_reason),'') where id=p_id;
end $$;
create or replace function public.rename_customer(p_id uuid,p_name text) returns void language plpgsql security definer set search_path=public as $$
declare v_name text:=trim(coalesce(p_name,''));
begin
  if auth.uid() is null or not is_admin() then raise exception 'المدير فقط'; end if;
  if v_name='' or length(v_name)>100 then raise exception 'اسم غير صحيح'; end if;
  if exists(select 1 from public.customers where lower(name)=lower(v_name) and id<>p_id) then raise exception 'يوجد عميل بهذا الاسم'; end if;
  update public.customers set name=v_name where id=p_id; if not found then raise exception 'العميل غير موجود'; end if;
end $$;
create or replace function public.delete_customer(p_id uuid) returns void language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is null or not is_admin() then raise exception 'المدير فقط'; end if;
  perform 1 from public.customers where id=p_id for update; if not found then raise exception 'العميل غير موجود'; end if;
  if exists(select 1 from public.invoices where customer_id=p_id) or exists(select 1 from public.payments where customer_id=p_id) then raise exception 'لا يمكن حذف عميل له حركات مسجّلة'; end if;
  delete from public.customers where id=p_id;
end $$;
revoke execute on function public.void_invoice(bigint,text),public.rename_customer(uuid,text),public.delete_customer(uuid) from public,anon;
grant execute on function public.void_invoice(bigint,text),public.rename_customer(uuid,text),public.delete_customer(uuid) to authenticated;

DO $$ declare r text; begin
  foreach r in array ARRAY['public.create_invoice(uuid,jsonb,numeric)','public.add_product(text,numeric,numeric)','public.receive_stock(uuid,numeric,text)'] loop
    if to_regprocedure(r) is not null then execute 'revoke execute on function '||r||' from authenticated'; end if;
  end loop;
END $$;
