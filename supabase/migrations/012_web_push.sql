-- depends: 010_settlement_invoice
-- Local implementation only: do not apply until reviewed and explicitly deployed.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions(user_id);

create table if not exists public.push_events (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in ('invoice_created','invoice_voided','credit_check')),
  actor_id uuid,
  customer_id uuid,
  invoice_id bigint,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists push_events_pending_idx
  on public.push_events(created_at) where processed_at is null;

create table if not exists public.push_credit_alerts (
  customer_id uuid not null references public.customers(id) on delete cascade,
  alert_date date not null,
  primary key(customer_id, alert_date)
);

alter table public.push_subscriptions enable row level security;
alter table public.push_events enable row level security;
alter table public.push_credit_alerts enable row level security;

-- Subscription endpoints are capability URLs; users may not read tables directly.
revoke all on public.push_subscriptions, public.push_events, public.push_credit_alerts
  from public, anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions, public.push_events,
  public.push_credit_alerts to service_role;

create or replace function public.save_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text
) returns void
language plpgsql security definer set search_path = public as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null or not public.is_admin() then raise exception 'المدير فقط'; end if;
  if p_endpoint is null or length(p_endpoint) > 2048
     or p_endpoint !~ '^https://[^[:space:]]+$' then
    raise exception 'اشتراك الإشعارات غير صحيح';
  end if;
  if p_p256dh is null or length(p_p256dh) < 20 or length(p_p256dh) > 256
     or p_auth is null or length(p_auth) < 8 or length(p_auth) > 128 then
    raise exception 'مفاتيح الاشتراك غير صحيحة';
  end if;
  insert into public.push_subscriptions(user_id, endpoint, p256dh, auth)
  values(v_user, p_endpoint, p_p256dh, p_auth)
  on conflict(endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function public.has_push_subscription(p_endpoint text)
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and public.is_admin()
    and exists(select 1 from public.push_subscriptions
               where user_id = auth.uid() and endpoint = p_endpoint)
$$;

create or replace function public.delete_push_subscription(p_endpoint text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_deleted boolean := false;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'المدير فقط'; end if;
  delete from public.push_subscriptions
   where user_id = auth.uid() and endpoint = p_endpoint;
  v_deleted := found;
  return v_deleted;
end $$;

revoke all on function public.save_push_subscription(text,text,text),
  public.has_push_subscription(text), public.delete_push_subscription(text)
  from public, anon;
grant execute on function public.save_push_subscription(text,text,text),
  public.has_push_subscription(text), public.delete_push_subscription(text)
  to authenticated;

create or replace function public.queue_invoice_push_events()
returns trigger
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_role text;
begin
  if tg_op = 'INSERT' then
    if new.customer_id is null then return new; end if;
    v_actor := new.created_by;
    if v_actor is not null then
      select role into v_role from public.profiles where id = v_actor;
      if v_role = 'seller' then
        insert into public.push_events(event_type, actor_id, customer_id, invoice_id)
        values('invoice_created', v_actor, new.customer_id, new.id);
      end if;
    end if;
    if new.kind = 'invoice' and new.voided_at is null then
      insert into public.push_events(event_type, actor_id, customer_id, invoice_id)
      values('credit_check', v_actor, new.customer_id, new.id);
    end if;
  else
    if new.customer_id is not null and new.kind = 'invoice'
       and (old.total is distinct from new.total or old.voided_at is distinct from new.voided_at) then
      insert into public.push_events(event_type, actor_id, customer_id, invoice_id)
      values('credit_check', coalesce(new.voided_by, new.edited_by), new.customer_id, new.id);
    end if;
    if old.voided_at is null and new.voided_at is not null and new.voided_by is not null then
      v_actor := new.voided_by;
      select role into v_role from public.profiles where id = v_actor;
      if v_role = 'seller' then
        insert into public.push_events(event_type, actor_id, customer_id, invoice_id)
        values('invoice_voided', v_actor, new.customer_id, new.id);
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists invoice_push_events on public.invoices;
create trigger invoice_push_events
after insert or update of total, voided_at on public.invoices
for each row execute function public.queue_invoice_push_events();

create or replace function public.queue_payment_credit_check()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.customer_id is not null then
    insert into public.push_events(event_type, actor_id, customer_id)
    values('credit_check', coalesce(new.voided_by, new.edited_by, new.created_by), new.customer_id);
  end if;
  return new;
end $$;

drop trigger if exists payment_credit_check on public.payments;
create trigger payment_credit_check
after insert or update of amount, voided_at on public.payments
for each row execute function public.queue_payment_credit_check();

create or replace function public.queue_customer_credit_check()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.credit_limit is distinct from new.credit_limit then
    insert into public.push_events(event_type, customer_id)
    values('credit_check', new.id);
  end if;
  return new;
end $$;

drop trigger if exists customer_credit_check on public.customers;
create trigger customer_credit_check
after update of credit_limit on public.customers
for each row execute function public.queue_customer_credit_check();

revoke all on function public.queue_invoice_push_events(),
  public.queue_payment_credit_check(), public.queue_customer_credit_check()
  from public, anon, authenticated;

-- No trigger calls the Edge Function directly. Configure a Database Webhook on
-- INSERT to public.push_events after deploying push-notify (see README).
