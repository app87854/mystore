-- depends: 018_allow_overpayment_credit
-- Consolidates bug fixes for existing deployments:
-- 1. Enforce credit_limit and post-rounding > 0 checks in update_debt_invoice and update_payment.
-- 2. Include current debt and limit in create_debt_invoice credit limit error message.
-- 3. Trigger credit_check when any invoice total changes or an invoice is voided (queue_invoice_push_events only;
--    queue_payment_credit_check for payments is unchanged). credit_check is an internal event, not a guaranteed
--    notification: push-notify decides whether to alert when the threshold is reached.

create or replace function public.create_debt_invoice(
  p_customer uuid,
  p_amount numeric,
  p_note text,
  p_kind text default 'invoice'
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit numeric;
  v_debt numeric;
  v_id bigint;
  v_amt numeric;
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if p_kind not in ('invoice', 'disbursement') then raise exception 'نوع غير صحيح'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000 then
    raise exception 'القيمة غير صحيحة';
  end if;
  v_amt := round(p_amount, 2);
  if v_amt <= 0 then raise exception 'القيمة غير صحيحة'; end if;

  select credit_limit into v_limit
  from public.customers where id = p_customer for update;
  if not found then raise exception 'العميل غير موجود'; end if;

  if p_kind = 'invoice' then
    select debt into v_debt
    from public.customer_balances where id = p_customer;
    if v_limit > 0 and v_debt + v_amt > v_limit then
      raise exception 'يتجاوز حد الائتمان (الدين الحالي %، الحد %)', v_debt, v_limit;
    end if;
  end if;

  insert into public.invoices(customer_id, total, paid, note, kind)
  values (p_customer, v_amt, 0, nullif(trim(p_note), ''), p_kind)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.update_debt_invoice(p_id bigint, p_amount numeric, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amt numeric;
  v_cust uuid;
  v_limit numeric;
  v_debt numeric;
  v_old numeric;
  v_kind text;
begin
  if auth.uid() is null or not is_admin() then raise exception 'المدير فقط'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000 then raise exception 'القيمة غير صحيحة'; end if;
  v_amt := round(p_amount, 2);
  if v_amt <= 0 then raise exception 'القيمة غير صحيحة'; end if;

  select customer_id, total, kind into v_cust, v_old, v_kind
  from public.invoices where id = p_id for update;
  if not found then raise exception 'الفاتورة غير موجودة'; end if;
  if exists(select 1 from public.invoice_items where invoice_id = p_id) then
    raise exception 'فاتورة مبيعات مخزنية: لا تعدل من هنا';
  end if;
  if v_cust is not null then
    select credit_limit into v_limit from public.customers where id = v_cust for update;
  end if;
  if exists(select 1 from public.invoices where id = p_id and voided_at is not null) then
    raise exception 'الفاتورة ملغاة';
  end if;
  if v_cust is not null and v_kind = 'invoice' and v_limit > 0 then
    select debt into v_debt from public.customer_balances where id = v_cust;
    -- التخفيض (أو بقاء القيمة) مسموح دائماً حتى لو بقي العميل فوق حده؛ يُرفض فقط ما يزيد القيمة ويتجاوز الحد
    if v_amt > coalesce(v_old, 0) and (v_debt - coalesce(v_old, 0) + v_amt) > v_limit then
      raise exception 'يتجاوز حد الائتمان (الدين الحالي %، الحد %)', v_debt, v_limit;
    end if;
  end if;

  update public.invoices
  set total = v_amt, note = nullif(trim(p_note), ''), edited_at = now(), edited_by = auth.uid()
  where id = p_id;
end;
$$;

create or replace function public.update_payment(p_id bigint, p_amount numeric, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amt numeric;
  v_cust uuid;
begin
  if auth.uid() is null or not is_admin() then raise exception 'المدير فقط'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000 then raise exception 'مبلغ غير صحيح'; end if;
  v_amt := round(p_amount, 2);
  if v_amt <= 0 then raise exception 'مبلغ غير صحيح'; end if;
  select customer_id into v_cust from public.payments where id = p_id for update;
  if not found then raise exception 'التسديد غير موجود'; end if;
  perform 1 from public.customers where id = v_cust for update;
  if exists(select 1 from public.payments where id = p_id and voided_at is not null) then
    raise exception 'التسديد ملغى';
  end if;
  update public.payments
  set amount = v_amt, note = nullif(trim(p_note), ''), edited_at = now(), edited_by = auth.uid()
  where id = p_id;
end;
$$;

create or replace function public.queue_invoice_push_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.customer_id is null then return new; end if;
    insert into public.push_events(event_type, actor_id, customer_id, invoice_id)
    values('invoice_created', new.created_by, new.customer_id, new.id);
    if new.kind = 'invoice' and new.voided_at is null then
      insert into public.push_events(event_type, actor_id, customer_id, invoice_id)
      values('credit_check', new.created_by, new.customer_id, new.id);
    end if;
  else
    if new.customer_id is not null
       and (old.total is distinct from new.total or old.voided_at is distinct from new.voided_at) then
      insert into public.push_events(event_type, actor_id, customer_id, invoice_id)
      values('credit_check', coalesce(new.voided_by, new.edited_by), new.customer_id, new.id);
    end if;
    if old.voided_at is null and new.voided_at is not null then
      insert into public.push_events(event_type, actor_id, customer_id, invoice_id)
      values('invoice_voided', new.voided_by, new.customer_id, new.id);
    end if;
  end if;
  return new;
end;
$$;
