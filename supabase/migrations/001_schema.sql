-- depends: none
-- Base tables for the debt system and legacy inventory compatibility.

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text,
  name text not null,
  role text not null default 'seller' check (role in ('admin','seller'))
);
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(), name text not null, phone text,
  created_at timestamptz not null default now()
);
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(), name text not null,
  price numeric(12,2) not null default 0 check (price >= 0),
  stock numeric(12,3) not null default 0 check (stock >= 0),
  created_at timestamptz not null default now()
);
create table if not exists public.invoices (
  id bigint generated always as identity primary key,
  customer_id uuid references public.customers(id),
  total numeric(12,2) not null default 0,
  paid numeric(12,2) not null default 0 check (paid >= 0),
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create table if not exists public.invoice_items (
  id bigint generated always as identity primary key,
  invoice_id bigint not null references public.invoices(id), product_id uuid references public.products(id),
  product_name text not null, qty numeric(12,3) not null check (qty > 0),
  price numeric(12,2) not null check (price >= 0), line_total numeric(12,2) not null
);
create table if not exists public.payments (
  id bigint generated always as identity primary key,
  customer_id uuid not null references public.customers(id), amount numeric(12,2) not null check (amount > 0),
  note text, created_by uuid references public.profiles(id) default auth.uid(), created_at timestamptz not null default now()
);
create table if not exists public.stock_movements (
  id bigint generated always as identity primary key,
  product_id uuid not null references public.products(id), qty numeric(12,3) not null,
  kind text not null check (kind in ('opening','supply','sale')), invoice_id bigint references public.invoices(id),
  note text, created_by uuid references public.profiles(id) default auth.uid(), created_at timestamptz not null default now()
);

create or replace view public.customer_balances with (security_invoker = true) as
select c.id, c.name, c.phone,
  coalesce((select sum(i.total - i.paid) from public.invoices i where i.customer_id = c.id), 0)
  - coalesce((select sum(p.amount) from public.payments p where p.customer_id = c.id), 0) as debt
from public.customers c;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, role) values (new.id, split_part(new.email, '@', 1),
    case when exists (select 1 from public.profiles) then 'seller' else 'admin' end);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.payments enable row level security;
alter table public.stock_movements enable row level security;

grant select on public.profiles, public.customers, public.products, public.invoices,
  public.invoice_items, public.payments, public.stock_movements to authenticated;
grant insert, update on public.customers to authenticated;

drop policy if exists "read" on public.profiles;
create policy "read" on public.profiles for select to authenticated using (true);
drop policy if exists "read" on public.customers;
create policy "read" on public.customers for select to authenticated using (true);
drop policy if exists "add" on public.customers;
create policy "add" on public.customers for insert to authenticated with check (true);
drop policy if exists "edit" on public.customers;
create policy "edit" on public.customers for update to authenticated using (true) with check (true);
drop policy if exists "delete" on public.customers;
create policy "delete" on public.customers for delete to authenticated using (is_admin());

drop policy if exists "read" on public.invoices;
create policy "read" on public.invoices for select to authenticated using (true);
drop policy if exists "read" on public.invoice_items;
create policy "read" on public.invoice_items for select to authenticated using (true);
drop policy if exists "read" on public.payments;
create policy "read" on public.payments for select to authenticated using (true);
drop policy if exists "read" on public.stock_movements;
create policy "read" on public.stock_movements for select to authenticated using (true);
drop policy if exists "read" on public.products;
create policy "read" on public.products for select to authenticated using (true);

DO $$ BEGIN
  BEGIN alter publication supabase_realtime add table public.invoices, public.products, public.customers, public.payments; EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;
