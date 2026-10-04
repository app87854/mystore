-- depends: 012_web_push
-- Lower-privilege push delivery: no supabase_functions_admin role and no grants
-- of net.http_* to anon/authenticated. Secrets are stored in Supabase Vault.
-- pg_cron is enabled only for bounded pending-event retries; no cleanup job is
-- scheduled here (013's cleanup deletes historical rows and remains unapplied).

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create or replace function public.push_events_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets
   where name = 'push_function_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'push_webhook_secret';

  if v_url is null or v_secret is null then
    raise warning 'push_events_notify: أسرار Vault غير مضبوطة';
    return new;
  end if;

  begin
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-push-webhook-secret', v_secret
      ),
      body := jsonb_build_object(
        'type', 'INSERT',
        'schema', 'public',
        'table', 'push_events',
        'record', jsonb_build_object('id', new.id)
      )
    );
  exception when others then
    -- Push delivery must not roll back invoice or payment writes.
    raise warning 'push_events_notify: %', sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function public.push_events_notify()
  from public, anon, authenticated;

drop trigger if exists push_events_notify on public.push_events;
create trigger push_events_notify
after insert on public.push_events
for each row execute function public.push_events_notify();

-- Retry events left pending by transient network failures. This job only reads
-- and retries pending events; it does not delete invoice, payment, or event rows.
do $schedule$
begin
  if not exists (
    select 1 from cron.job where jobname = 'push-events-retry'
  ) then
    perform cron.schedule(
      'push-events-retry',
      '*/5 * * * *',
      $job$
        select net.http_post(
          url := (select decrypted_secret
                    from vault.decrypted_secrets
                   where name = 'push_function_url'),
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-push-webhook-secret',
            (select decrypted_secret
               from vault.decrypted_secrets
              where name = 'push_webhook_secret')
          ),
          body := '{"action":"retry_pending"}'::jsonb
        );
      $job$
    );
  end if;
end;
$schedule$;
