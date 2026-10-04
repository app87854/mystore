-- depends: 015_security_hardening (أو 014 على الأقل)
-- يُطبَّق بعد نشر push-notify المحدَّثة، وإلا تُعالَج الأحداث الجديدة بالنسخة القديمة وتُتجاهَل.
--
-- الهدف: إشعار كل المديرين المشتركين عند تسجيل فاتورة أو إلغائها، حتى لو كان الفاعل مديراً.
-- الفرق عن 012: حُذف شرط (دور الفاعل = seller). منطق credit_check لم يتغير.

create or replace function public.queue_invoice_push_events()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.customer_id is null then return new; end if;
    insert into public.push_events(event_type, actor_id, customer_id, invoice_id)
    values('invoice_created', new.created_by, new.customer_id, new.id);
    if new.kind = 'invoice' and new.voided_at is null then
      insert into public.push_events(event_type, actor_id, customer_id, invoice_id)
      values('credit_check', new.created_by, new.customer_id, new.id);
    end if;
  else
    if new.customer_id is not null and new.kind = 'invoice'
       and (old.total is distinct from new.total or old.voided_at is distinct from new.voided_at) then
      insert into public.push_events(event_type, actor_id, customer_id, invoice_id)
      values('credit_check', coalesce(new.voided_by, new.edited_by), new.customer_id, new.id);
    end if;
    if old.voided_at is null and new.voided_at is not null then
      insert into public.push_events(event_type, actor_id, customer_id, invoice_id)
      values('invoice_voided', new.voided_by, new.customer_id, new.id);
    end if;
  end if;
  return new;
end $$;

revoke all on function public.queue_invoice_push_events() from public, anon, authenticated;

-- للتراجع: أعد تعريف الدالة من 012_web_push.sql (النسخة التي تشترط دور seller).
