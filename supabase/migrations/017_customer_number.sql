-- depends: 016_push_all_admins
-- Assign immutable sequential numbers to customers without changing UUID keys.
-- Existing customers are numbered by created_at, then id (oldest first).
--
-- Intentionally do NOT set a column DEFAULT: the BEFORE INSERT trigger is the
-- single numbering source, always overwrites client input, and consumes exactly
-- one sequence value per insert. DEFAULT nextval plus this trigger would skip
-- one number on every ordinary insert and require API roles to use the sequence.
--
-- Rollback note (after reverting frontend references): restore the old
-- customer_balances definition without customer_no, drop both triggers and
-- trigger functions, drop the unique constraint, then drop the customer_no
-- column. The sequence is owned by that column and is dropped with it. This
-- removes the assigned display numbers but does not alter invoices/payments.

lock table public.customers in access exclusive mode;

create sequence if not exists public.customers_customer_no_seq as integer;
alter table public.customers
  add column if not exists customer_no integer;

with ranked as (
  select id, row_number() over (order by created_at, id)::integer as assigned_no
  from public.customers
)
update public.customers as c
set customer_no = ranked.assigned_no
from ranked
where c.id = ranked.id
  and c.customer_no is null;

alter sequence public.customers_customer_no_seq
  owned by public.customers.customer_no;

-- Initialize/advance only; never rewind an already-used sequence on re-run.
do $$
declare
  v_max integer;
  v_last integer;
  v_called boolean;
begin
  select max(customer_no)::integer into v_max from public.customers;
  select last_value, is_called into v_last, v_called
    from public.customers_customer_no_seq;

  if v_max is null then
    if not v_called then
      perform setval('public.customers_customer_no_seq'::regclass, 1, false);
    end if;
  elsif not v_called or v_last < v_max then
    perform setval('public.customers_customer_no_seq'::regclass, v_max, true);
  end if;
end
$$;

alter table public.customers
  alter column customer_no set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.customers'::regclass
      and conname = 'customers_customer_no_key'
  ) then
    alter table public.customers
      add constraint customers_customer_no_key unique (customer_no);
  end if;
end
$$;

create or replace function public.assign_customer_no_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.customer_no := nextval('public.customers_customer_no_seq'::regclass)::integer;
  return new;
end
$$;

create or replace function public.prevent_customer_no_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.customer_no is distinct from old.customer_no then
    raise exception using
      errcode = '23514',
      message = 'customer_no is immutable';
  end if;
  return new;
end
$$;

revoke all privileges on sequence public.customers_customer_no_seq
  from public, anon, authenticated;
revoke all privileges on function public.assign_customer_no_before_insert()
  from public, anon, authenticated;
revoke all privileges on function public.prevent_customer_no_update()
  from public, anon, authenticated;

drop trigger if exists customers_assign_customer_no on public.customers;
create trigger customers_assign_customer_no
before insert on public.customers
for each row execute function public.assign_customer_no_before_insert();

drop trigger if exists customers_prevent_customer_no_update on public.customers;
create trigger customers_prevent_customer_no_update
before update on public.customers
for each row execute function public.prevent_customer_no_update();

-- Append customer_no to preserve every existing view column name and position.
-- CREATE OR REPLACE VIEW preserves the current grants; retain security_invoker.
create or replace view public.customer_balances
with (security_invoker = true) as
select
  c.id,
  c.name,
  c.phone,
  coalesce((
    select sum(i.total - i.paid)
    from public.invoices as i
    where i.customer_id = c.id
      and i.kind = 'invoice'
      and i.voided_at is null
  ), 0)
  - coalesce((
    select sum(i.total)
    from public.invoices as i
    where i.customer_id = c.id
      and i.kind = 'disbursement'
      and i.voided_at is null
  ), 0)
  - coalesce((
    select sum(p.amount)
    from public.payments as p
    where p.customer_id = c.id
      and p.voided_at is null
  ), 0) as debt,
  c.credit_limit,
  c.customer_no
from public.customers as c;
