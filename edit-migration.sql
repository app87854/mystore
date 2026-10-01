-- شغّله مرة واحدة بعد schema.sql وusers-migration.sql وdebts-migration.sql.
-- يضيف: إلغاء الفواتير، تعديل اسم العميل، حذف العميل، وإصلاحات المراجعة.
-- تنبيه: غيّر المنطقة الزمنية 'Africa/Tripoli' أدناه (في store_stats) إلى منطقتك.

-- ===== 1) إصلاحات أمنية =====
-- دوال المبيعات القديمة تتجاوز حد الائتمان ولم تعد مستخدمة
revoke execute on function public.create_invoice(uuid, jsonb, numeric),
                           public.add_product(text, numeric, numeric),
                           public.receive_stock(uuid, numeric, text) from authenticated;

-- منع تكرار اسم المستخدم باختلاف حالة الأحرف (يفشل إن وُجد تكرار حالي: عدّل الاسمين ثم أعد التشغيل)
create unique index if not exists profiles_username_lower on profiles (lower(username));

-- ===== 2) إلغاء الفواتير (إلغاء منطقي: يبقى السجل ويُستثنى من الدين) =====
alter table invoices add column if not exists voided_at timestamptz;
alter table invoices add column if not exists voided_by uuid;
alter table invoices add column if not exists void_reason text;

create or replace view customer_balances with (security_invoker = true) as
select c.id, c.name, c.phone,
  coalesce((select sum(i.total - i.paid) from invoices i where i.customer_id = c.id and i.voided_at is null), 0)
  - coalesce((select sum(p.amount) from payments p where p.customer_id = c.id), 0) as debt,
  c.credit_limit
from customers c;

-- "اليوم" بتوقيت منطقتك لا بتوقيت الخادم
create or replace view store_stats with (security_invoker = true) as
with d as (select date_trunc('day', now() at time zone 'Africa/Tripoli') at time zone 'Africa/Tripoli' as s)
select
  (select count(*) from customers) as customers_count,
  (select coalesce(sum(greatest(debt, 0)), 0) from customer_balances) as total_debt,
  (select coalesce(sum(total), 0) from invoices where kind = 'invoice' and voided_at is null) as total_invoiced,
  (select coalesce(sum(total), 0) from invoices where kind = 'disbursement' and voided_at is null) as total_disbursed,
  (select coalesce(sum(amount), 0) from payments) as total_paid,
  ((select coalesce(sum(total), 0) from invoices where voided_at is null and created_at >= d.s)
   - (select coalesce(sum(amount), 0) from payments where created_at >= d.s)) as today_debt,
  (select coalesce(sum(amount), 0) from payments where created_at >= d.s) as today_paid
from d;

create or replace function void_invoice(p_id bigint, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_cust uuid; v_void timestamptz;
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if not is_admin() then raise exception 'المدير فقط'; end if;
  select customer_id into v_cust from invoices where id = p_id;
  if not found then raise exception 'الفاتورة غير موجودة'; end if;
  if exists (select 1 from invoice_items where invoice_id = p_id) then
    raise exception 'فاتورة مبيعات مخزنية: لا تُلغى من هنا';
  end if;
  if v_cust is not null then perform 1 from customers where id = v_cust for update; end if;
  select voided_at into v_void from invoices where id = p_id for update;
  if v_void is not null then raise exception 'الفاتورة ملغاة مسبقاً'; end if;
  update invoices
     set voided_at = now(), voided_by = auth.uid(), void_reason = nullif(trim(p_reason), '')
   where id = p_id;
end $$;

-- ===== 3) تعديل اسم العميل وحذفه (للمدير فقط) =====
create or replace function rename_customer(p_id uuid, p_name text)
returns void language plpgsql security definer set search_path = public as $$
declare v_name text := trim(coalesce(p_name, ''));
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if not is_admin() then raise exception 'المدير فقط'; end if;
  if v_name = '' or length(v_name) > 100 then raise exception 'اسم غير صحيح'; end if;
  if exists (select 1 from customers where lower(name) = lower(v_name) and id <> p_id) then
    raise exception 'يوجد عميل بهذا الاسم';
  end if;
  update customers set name = v_name where id = p_id;
  if not found then raise exception 'العميل غير موجود'; end if;
end $$;

-- لا يُحذف إلا عميل بلا أي حركات (حفظاً لسجل الحسابات)
create or replace function delete_customer(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if not is_admin() then raise exception 'المدير فقط'; end if;
  perform 1 from customers where id = p_id for update;
  if not found then raise exception 'العميل غير موجود'; end if;
  if exists (select 1 from invoices where customer_id = p_id)
     or exists (select 1 from payments where customer_id = p_id) then
    raise exception 'لا يمكن حذف عميل له حركات مسجّلة (فواتير أو تسديدات)';
  end if;
  delete from customers where id = p_id;
end $$;

revoke execute on function void_invoice(bigint, text), rename_customer(uuid, text), delete_customer(uuid) from public, anon;
grant  execute on function void_invoice(bigint, text), rename_customer(uuid, text), delete_customer(uuid) to authenticated;

-- ===== 4) تحسينات الفحص: التقريب قبل المقارنة، وسقف للمبلغ =====
create or replace function create_debt_invoice(p_customer uuid, p_amount numeric, p_note text, p_kind text default 'invoice')
returns bigint language plpgsql security definer set search_path = public as $$
declare v_limit numeric; v_debt numeric; v_id bigint; v_amt numeric;
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if p_kind not in ('invoice', 'disbursement') then raise exception 'نوع غير صحيح'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000 then raise exception 'القيمة غير صحيحة'; end if;
  v_amt := round(p_amount, 2);
  if v_amt <= 0 then raise exception 'القيمة غير صحيحة'; end if;

  select credit_limit into v_limit from customers where id = p_customer for update;
  if not found then raise exception 'العميل غير موجود'; end if;

  select debt into v_debt from customer_balances where id = p_customer;
  if v_limit > 0 and v_debt + v_amt > v_limit then
    raise exception 'يتجاوز حد الائتمان (الدين الحالي %، الحد %)', v_debt, v_limit;
  end if;

  insert into invoices (customer_id, total, paid, note, kind)
  values (p_customer, v_amt, 0, nullif(trim(p_note), ''), p_kind)
  returning id into v_id;
  return v_id;
end $$;

create or replace function add_payment(p_customer uuid, p_amount numeric, p_note text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_debt numeric; v_id bigint; v_amt numeric;
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000 then raise exception 'مبلغ غير صحيح'; end if;
  v_amt := round(p_amount, 2);
  if v_amt <= 0 then raise exception 'مبلغ غير صحيح'; end if;
  perform 1 from customers where id = p_customer for update;
  if not found then raise exception 'العميل غير موجود'; end if;
  select debt into v_debt from customer_balances where id = p_customer;
  if v_amt > v_debt then raise exception 'المبلغ أكبر من الدين الحالي (%)', v_debt; end if;
  insert into payments (customer_id, amount, note) values (p_customer, v_amt, nullif(trim(p_note), '')) returning id into v_id;
  return v_id;
end $$;
