-- depends: 014_push_webhook_notify
-- تشديد صلاحيات التنفيذ (لا يغيّر أي منطق عمل ولا بيانات).
--
-- 1) handle_new_user() دالة trigger على auth.users؛ لا يجب أن تُستدعى عبر /rest/v1/rpc.
--    صلاحية EXECUTE لا تُفحص عند إطلاق الـ trigger، لذا سحبها آمن.
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- 2) is_admin() تُستخدم في سياسات RLS لدور authenticated فقط، فنسحبها من anon.
--    تبقى متاحة لـ authenticated لأن السياسات تحتاجها.
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ملاحظة: login_email(text) تبقى متاحة لـ anon عمداً (تسجيل الدخول باسم المستخدم).
--
-- للتراجع:
--   grant execute on function public.handle_new_user() to anon, authenticated;
--   grant execute on function public.is_admin() to anon;
