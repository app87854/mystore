-- شغّله مرة واحدة فوق schema.sql وusers-migration.sql اللذين نفّذتهما.
-- لا يحذف شيئاً: جداول الأصناف والمخزون تبقى دون استخدام.

-- حد الائتمان للعميل (0 = بلا حد) وملاحظات الفاتورة (المشتريات المكتوبة يدوياً)
alter table customers add column if not exists credit_limit numeric(12,2) not null default 0 check (credit_limit >= 0);
alter table invoices  add column if not exists note text;

-- العرض يضم حد الائتمان (العمود الجديد في آخر القائمة)
create or replace view customer_balances with (security_invoker = true) as
select c.id, c.name, c.phone,
  coalesce((select sum(i.total - i.paid) from invoices i where i.customer_id = c.id), 0)
  - coalesce((select sum(p.amount) from payments p where p.customer_id = c.id), 0) as debt,
  c.credit_limit
from customers c;

-- فاتورة دين: المنفّذ يؤخذ من الجلسة، ويُرفض ما يتجاوز حد الائتمان
create or replace function create_debt_invoice(p_customer uuid, p_amount numeric, p_note text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_limit numeric; v_debt numeric; v_id bigint;
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'القيمة غير صحيحة'; end if;

  select credit_limit into v_limit from customers where id = p_customer for update;
  if not found then raise exception 'العميل غير موجود'; end if;

  select debt into v_debt from customer_balances where id = p_customer;
  if v_limit > 0 and v_debt + p_amount > v_limit then
    raise exception 'يتجاوز حد الائتمان (الدين الحالي %، الحد %)', v_debt, v_limit;
  end if;

  insert into invoices (customer_id, total, paid, note)
  values (p_customer, round(p_amount, 2), 0, nullif(trim(p_note), ''))
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function create_debt_invoice(uuid, numeric, text) from public, anon;
grant  execute on function create_debt_invoice(uuid, numeric, text) to authenticated;

-- تعديل بيانات العميل (ومنها حد الائتمان) للمدير فقط
drop policy if exists "add" on customers;
create policy "add" on customers for insert to authenticated
with check (credit_limit = 0 or is_admin());

drop policy if exists "edit" on customers;
create policy "edit" on customers for update to authenticated using (is_admin()) with check (is_admin());
