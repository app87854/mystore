-- depends: 019_fixes
-- دوال المشغّلات لا تحتاج EXECUTE لأي دور API: صلاحية تنفيذ دالة المشغّل تُفحص عند إنشاء المشغّل لا عند تنفيذه.
-- هذا الترحيل يوحّد القواعد الجديدة المبنية من 012 و016 و017 مع الإنتاج (حيث لا يملكها إلا postgres وservice_role).
-- لا يمسّ دوال الواجهة (save_push_subscription وغيرها) ولا أي بيانات. آمن عند إعادة التشغيل.
revoke execute on function
  public.queue_invoice_push_events(),
  public.queue_payment_credit_check(),
  public.queue_customer_credit_check(),
  public.assign_customer_no_before_insert(),
  public.prevent_customer_no_update()
from public, anon, authenticated;

-- Rollback (غير مستحسن):
--   grant execute on function public.queue_invoice_push_events(), public.queue_payment_credit_check(),
--     public.queue_customer_credit_check(), public.assign_customer_no_before_insert(),
--     public.prevent_customer_no_update() to authenticated;
