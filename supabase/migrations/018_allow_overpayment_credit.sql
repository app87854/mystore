-- depends: 017_customer_number
-- Allow settlement amounts to exceed the current debt.
-- The balance view already computes net debt as invoices minus payments, so an
-- overpayment becomes a negative balance (customer credit) and is offset by
-- later invoices. No payment rows or existing balances are rewritten here.

create or replace function public.add_payment(p_customer uuid, p_amount numeric, p_note text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  v_amt numeric;
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000 then
    raise exception 'مبلغ غير صحيح';
  end if;
  v_amt := round(p_amount, 2);
  if v_amt <= 0 then raise exception 'مبلغ غير صحيح'; end if;

  -- Serialize payments and invoices for this customer and ensure the customer exists.
  perform 1 from public.customers where id = p_customer for update;
  if not found then raise exception 'العميل غير موجود'; end if;

  insert into public.payments(customer_id, amount, note)
  values (p_customer, v_amt, nullif(trim(p_note), ''))
  returning id into v_id;
  return v_id;
end;
$$;

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
      raise exception 'يتجاوز حد الائتمان';
    end if;
  end if;
  -- A disbursement may now exceed debt; the resulting negative net balance
  -- is the customer's credit and offsets subsequent debt invoices.

  insert into public.invoices(customer_id, total, paid, note, kind)
  values (p_customer, v_amt, 0, nullif(trim(p_note), ''), p_kind)
  returning id into v_id;
  return v_id;
end;
$$;

-- CREATE OR REPLACE preserves the existing function owners and ACLs.
