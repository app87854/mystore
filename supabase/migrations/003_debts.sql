-- depends: 002_users

alter table public.customers add column if not exists credit_limit numeric(12,2) not null default 0 check (credit_limit >= 0);
alter table public.invoices add column if not exists note text;
create or replace view public.customer_balances with (security_invoker = true) as
select c.id, c.name, c.phone,
  coalesce((select sum(i.total - i.paid) from public.invoices i where i.customer_id = c.id), 0)
  - coalesce((select sum(p.amount) from public.payments p where p.customer_id = c.id), 0) as debt,
  c.credit_limit
from public.customers c;

create or replace function public.create_debt_invoice(p_customer uuid, p_amount numeric, p_note text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_limit numeric; v_debt numeric; v_id bigint;
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'القيمة غير صحيحة'; end if;
  select credit_limit into v_limit from public.customers where id=p_customer for update;
  if not found then raise exception 'العميل غير موجود'; end if;
  select debt into v_debt from public.customer_balances where id=p_customer;
  if v_limit > 0 and v_debt + p_amount > v_limit then raise exception 'يتجاوز حد الائتمان'; end if;
  insert into public.invoices(customer_id,total,paid,note) values(p_customer,round(p_amount,2),0,nullif(trim(p_note),'')) returning id into v_id;
  return v_id;
end $$;
create or replace function public.add_payment(p_customer uuid,p_amount numeric,p_note text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_debt numeric; v_id bigint;
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'مبلغ غير صحيح'; end if;
  perform 1 from public.customers where id=p_customer for update;
  if not found then raise exception 'العميل غير موجود'; end if;
  select debt into v_debt from public.customer_balances where id=p_customer;
  if p_amount > v_debt then raise exception 'المبلغ أكبر من الدين الحالي (%)',v_debt; end if;
  insert into public.payments(customer_id,amount,note) values(p_customer,p_amount,nullif(trim(p_note),'')) returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.create_debt_invoice(uuid,numeric,text), public.add_payment(uuid,numeric,text) from public, anon;
grant execute on function public.create_debt_invoice(uuid,numeric,text), public.add_payment(uuid,numeric,text) to authenticated;

drop policy if exists "add" on public.customers;
create policy "add" on public.customers for insert to authenticated with check (credit_limit=0 or is_admin());
drop policy if exists "edit" on public.customers;
create policy "edit" on public.customers for update to authenticated using (is_admin()) with check (is_admin());
