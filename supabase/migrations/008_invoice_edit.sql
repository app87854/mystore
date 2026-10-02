-- depends: 007_seller_void
-- Allow administrators to edit non-inventory, non-voided invoice amount and note.
create or replace function public.update_debt_invoice(p_id bigint, p_amount numeric, p_note text)
returns void language plpgsql security definer set search_path=public as $$
declare v_amt numeric;
begin
  if auth.uid() is null or not is_admin() then raise exception 'المدير فقط'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000 then raise exception 'القيمة غير صحيحة'; end if;
  v_amt := round(p_amount, 2);
  if v_amt <= 0 then raise exception 'القيمة غير صحيحة'; end if;
  if exists(select 1 from public.invoice_items where invoice_id=p_id) then
    raise exception 'فاتورة مبيعات مخزنية: لا تعدل من هنا';
  end if;
  update public.invoices
  set total=v_amt, note=nullif(trim(p_note),'')
  where id=p_id and voided_at is null;
  if not found then raise exception 'الفاتورة غير موجودة أو ملغاة'; end if;
end $$;
revoke execute on function public.update_debt_invoice(bigint,numeric,text) from public, anon;
grant execute on function public.update_debt_invoice(bigint,numeric,text) to authenticated;
