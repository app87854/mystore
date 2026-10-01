-- depends: 003_debts

alter table public.invoices add column if not exists kind text not null default 'invoice' check (kind in ('invoice','disbursement'));
drop function if exists public.create_debt_invoice(uuid,numeric,text);
create or replace function public.create_debt_invoice(p_customer uuid,p_amount numeric,p_note text,p_kind text default 'invoice')
returns bigint language plpgsql security definer set search_path = public as $$
declare v_limit numeric; v_debt numeric; v_id bigint;
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if p_kind not in ('invoice','disbursement') then raise exception 'نوع غير صحيح'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'القيمة غير صحيحة'; end if;
  select credit_limit into v_limit from public.customers where id=p_customer for update;
  if not found then raise exception 'العميل غير موجود'; end if;
  select debt into v_debt from public.customer_balances where id=p_customer;
  if v_limit > 0 and v_debt + p_amount > v_limit then raise exception 'يتجاوز حد الائتمان'; end if;
  insert into public.invoices(customer_id,total,paid,note,kind) values(p_customer,round(p_amount,2),0,nullif(trim(p_note),''),p_kind) returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.create_debt_invoice(uuid,numeric,text,text) from public, anon;
grant execute on function public.create_debt_invoice(uuid,numeric,text,text) to authenticated;
