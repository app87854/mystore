create table profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null,
  role text not null default 'seller' check (role in ('admin','seller'))
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  created_at timestamptz not null default now()
);

create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price numeric(12,2) not null default 0 check (price >= 0),
  stock numeric(12,3) not null default 0 check (stock >= 0),
  created_at timestamptz not null default now()
);

create table invoices (
  id bigint generated always as identity primary key,
  customer_id uuid references customers(id),
  total numeric(12,2) not null default 0,
  paid numeric(12,2) not null default 0 check (paid >= 0),
  created_by uuid references profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);

create table invoice_items (
  id bigint generated always as identity primary key,
  invoice_id bigint not null references invoices(id),
  product_id uuid references products(id),
  product_name text not null,
  qty numeric(12,3) not null check (qty > 0),
  price numeric(12,2) not null check (price >= 0),
  line_total numeric(12,2) not null
);

-- تسديدات الدين منفصلة عن الفواتير (كما في NamaIn)
create table payments (
  id bigint generated always as identity primary key,
  customer_id uuid not null references customers(id),
  amount numeric(12,2) not null check (amount > 0),
  note text,
  created_by uuid references profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);

-- دفتر حركة المخزون: سجل لا يُعدَّل ولا يُحذف، كل تغيير في الكمية له سطر
create table stock_movements (
  id bigint generated always as identity primary key,
  product_id uuid not null references products(id),
  qty numeric(12,3) not null,
  kind text not null check (kind in ('opening','supply','sale')),
  invoice_id bigint references invoices(id),
  note text,
  created_by uuid references profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);

-- الدين = مجموع (إجمالي - مدفوع) الفواتير - التسديدات
create view customer_balances with (security_invoker = true) as
select c.id, c.name, c.phone,
  coalesce((select sum(i.total - i.paid) from invoices i where i.customer_id = c.id), 0)
  - coalesce((select sum(p.amount) from payments p where p.customer_id = c.id), 0) as debt
from customers c;

-- ===== المستخدمون والأدوار =====
create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, name, role)
  values (new.id, split_part(new.email, '@', 1),
          case when exists (select 1 from profiles) then 'seller' else 'admin' end);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function handle_new_user();

create function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
$$;

-- لمن أنشأ مستخدمين قبل تشغيل هذا السكربت
insert into profiles (id, name, role)
select id, split_part(email, '@', 1), 'seller' from auth.users on conflict do nothing;
update profiles set role = 'admin'
where id = (select id from auth.users order by created_at limit 1)
  and not exists (select 1 from profiles where role = 'admin');

-- ===== العمليات: كلها ذرّية، والمنفّذ يُؤخذ من الجلسة لا من الواجهة =====
create function add_product(p_name text, p_price numeric, p_stock numeric) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if not is_admin() then raise exception 'المدير فقط'; end if;
  insert into products (name, price, stock) values (p_name, p_price, coalesce(p_stock, 0)) returning id into v_id;
  if coalesce(p_stock, 0) > 0 then
    insert into stock_movements (product_id, qty, kind) values (v_id, p_stock, 'opening');
  end if;
  return v_id;
end $$;

create function receive_stock(p_product uuid, p_qty numeric, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if not is_admin() then raise exception 'المدير فقط'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'كمية غير صحيحة'; end if;
  update products set stock = stock + p_qty where id = p_product;
  if not found then raise exception 'صنف غير موجود'; end if;
  insert into stock_movements (product_id, qty, kind, note) values (p_product, p_qty, 'supply', p_note);
end $$;

create function create_invoice(p_customer uuid, p_items jsonb, p_paid numeric) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint; v_total numeric := 0; it jsonb; v_prod products%rowtype;
  v_qty numeric; v_price numeric; v_line numeric;
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'الفاتورة فارغة'; end if;

  insert into invoices (customer_id) values (p_customer) returning id into v_id;

  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it->>'qty')::numeric;
    v_price := (it->>'price')::numeric;
    if v_qty <= 0 or v_price < 0 then raise exception 'كمية أو سعر غير صحيح'; end if;

    select * into v_prod from products where id = (it->>'product_id')::uuid for update;
    if not found then raise exception 'صنف غير موجود'; end if;
    if v_prod.stock < v_qty then raise exception 'الكمية غير كافية للصنف: %', v_prod.name; end if;

    v_line := round(v_qty * v_price, 2);
    update products set stock = stock - v_qty where id = v_prod.id;
    insert into invoice_items (invoice_id, product_id, product_name, qty, price, line_total)
      values (v_id, v_prod.id, v_prod.name, v_qty, v_price, v_line);
    insert into stock_movements (product_id, qty, kind, invoice_id) values (v_prod.id, -v_qty, 'sale', v_id);
    v_total := v_total + v_line;
  end loop;

  if coalesce(p_paid, 0) > v_total then raise exception 'المدفوع أكبر من إجمالي الفاتورة'; end if;
  if coalesce(p_paid, 0) < v_total and p_customer is null then raise exception 'اختر عميلاً للفاتورة الآجلة'; end if;

  update invoices set total = v_total, paid = coalesce(p_paid, 0) where id = v_id;
  return v_id;
end $$;

create function add_payment(p_customer uuid, p_amount numeric, p_note text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_debt numeric; v_id bigint;
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'مبلغ غير صحيح'; end if;
  perform 1 from customers where id = p_customer for update;
  select debt into v_debt from customer_balances where id = p_customer;
  if p_amount > v_debt then raise exception 'المبلغ أكبر من الدين الحالي (%)', v_debt; end if;
  insert into payments (customer_id, amount, note) values (p_customer, p_amount, p_note) returning id into v_id;
  return v_id;
end $$;

-- ===== الصلاحيات: الكتابة في الفواتير والمخزون عبر الدوال فقط =====
alter table profiles enable row level security;
alter table customers enable row level security;
alter table products enable row level security;
alter table invoices enable row level security;
alter table invoice_items enable row level security;
alter table payments enable row level security;
alter table stock_movements enable row level security;

revoke all on profiles, customers, products, invoices, invoice_items, payments, stock_movements from anon;
revoke insert, update, delete on profiles, invoices, invoice_items, payments, stock_movements from authenticated;
revoke insert, update on products from authenticated;
grant update (name, price) on products to authenticated;

create policy "read" on profiles        for select to authenticated using (true);
create policy "read" on invoices        for select to authenticated using (true);
create policy "read" on invoice_items   for select to authenticated using (true);
create policy "read" on payments        for select to authenticated using (true);
create policy "read" on stock_movements for select to authenticated using (true);

create policy "read"   on customers for select to authenticated using (true);
create policy "add"    on customers for insert to authenticated with check (true);
create policy "edit"   on customers for update to authenticated using (true) with check (true);
create policy "delete" on customers for delete to authenticated using (is_admin());

create policy "read"   on products for select to authenticated using (true);
create policy "edit"   on products for update to authenticated using (is_admin()) with check (is_admin());
create policy "delete" on products for delete to authenticated using (is_admin());

-- المزامنة اللحظية بين البائعين
alter publication supabase_realtime add table invoices, products, customers, payments;

-- ===== تقييد تنفيذ الدوال (يطبق بعد إنشاء الدوال) =====
-- is_admin و handle_new_user متروكتان عمداً: الأولى تُستدعى داخل سياسات RLS
-- والثانية trigger فقط، وكلتاهما لا تفيدان anon بشيء.
revoke execute on function public.add_product(text, numeric, numeric) from public, anon;
revoke execute on function public.receive_stock(uuid, numeric, text) from public, anon;
revoke execute on function public.create_invoice(uuid, jsonb, numeric) from public, anon;
revoke execute on function public.add_payment(uuid, numeric, text) from public, anon;
