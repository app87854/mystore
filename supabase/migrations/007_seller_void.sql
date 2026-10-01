-- depends: 006_stats
-- Sellers may void debt invoices and disbursement receipts; inventory sales remain protected.

create or replace function public.void_invoice(p_id bigint, p_reason text default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_cust uuid; v_void timestamptz;
begin
  if auth.uid() is null then raise exception 'غير مصرّح'; end if;
  select customer_id into v_cust from public.invoices where id=p_id;
  if not found then raise exception 'الفاتورة غير موجودة'; end if;
  if exists(select 1 from public.invoice_items where invoice_id=p_id) then
    raise exception 'فاتورة مبيعات مخزنية: لا تُلغى من هنا';
  end if;
  if v_cust is not null then perform 1 from public.customers where id=v_cust for update; end if;
  select voided_at into v_void from public.invoices where id=p_id for update;
  if v_void is not null then raise exception 'الفاتورة ملغاة مسبقاً'; end if;
  update public.invoices
  set voided_at=now(), voided_by=auth.uid(), void_reason=nullif(trim(p_reason),'')
  where id=p_id;
end $$;

revoke execute on function public.void_invoice(bigint,text) from public, anon;
grant execute on function public.void_invoice(bigint,text) to authenticated;
