-- depends: 001_schema

alter table public.profiles add column if not exists username text;
update public.profiles set username = coalesce(nullif(username, ''), name) where username is null or username = '';
create unique index if not exists profiles_username_lower on public.profiles (lower(username));
alter table public.profiles alter column username set not null;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, name, role)
  values (new.id, split_part(new.email, '@', 1), split_part(new.email, '@', 1),
    case when exists (select 1 from public.profiles) then 'seller' else 'admin' end);
  return new;
end $$;

insert into public.profiles (id, username, name, role)
select id, split_part(email, '@', 1), split_part(email, '@', 1), 'seller' from auth.users on conflict (id) do nothing;
update public.profiles set role = 'admin'
where id = (select id from auth.users order by created_at limit 1)
  and not exists (select 1 from public.profiles where role = 'admin');

create or replace function public.login_email(p_username text) returns text
language sql stable security definer set search_path = public, auth as $$
  select u.email from auth.users u join public.profiles p on p.id = u.id
  where lower(p.username) = lower(trim(p_username)) limit 1
$$;
revoke all on function public.login_email(text) from public;
grant execute on function public.login_email(text) to anon, authenticated;
