-- depends: 012_web_push
-- يتطلب تفعيل الامتدادات من Database → Extensions: pg_cron (للتنظيف) وpg_net + vault (لإعادة المحاولة).

-- 1) تنظيف يومي: لا تتراكم أحداث الإشعارات (SQL فقط)
select cron.schedule('push-events-cleanup', '17 3 * * *', $$
  delete from public.push_events where created_at < now() - interval '30 days';
  delete from public.push_credit_alerts where alert_date < current_date - 30;
$$);

-- 2) إعادة محاولة الأحداث المعلّقة كل 5 دقائق (Database Webhook لا يعيد المحاولة وحده).
--    نفّذ الخطوتين التاليتين يدوياً بعد استبدال القيم، ثم ألغِ التعليق:
--
-- select vault.create_secret('<نفس قيمة PUSH_WEBHOOK_SECRET>', 'push_webhook_secret');
--
-- select cron.schedule('push-events-retry', '*/5 * * * *', $job$
--   select net.http_post(
--     url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/push-notify',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'x-push-webhook-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'push_webhook_secret')),
--     body    := '{"action":"retry_pending"}'::jsonb)
-- $job$);
