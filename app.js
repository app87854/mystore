if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

const SUPABASE_URL = 'https://xnadkvsvdcksbusvobnk.supabase.co';
const SUPABASE_KEY = 'sb_publishable_bIQuyBrBDrE8SdX-W8iP4g_PvPuz_us';
const STORE_NAME   = 'سجل الديون';


const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const fmt = n => (Number(n) || 0).toFixed(2);
const num = s => Number(String(s ?? '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/٫/g, '.').replace(/[٬,\s]/g, ''));
const dt = d => new Date(d).toLocaleString('ar', { dateStyle:'short', timeStyle:'short' });
const coll = new Intl.Collator('ar', { numeric: true, sensitivity: 'base' });
let pushVapidPublicKey = null, pushBusy = false, pushInit = false;

function isIOSHomeScreenRequired(){
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  return ios && !standalone;
}
function pushSupported(){
  return window.isSecureContext && 'serviceWorker' in navigator &&
    'PushManager' in window && 'Notification' in window;
}
async function refreshPushSettings(){
  if (pushBusy) return;
  const card = $('#push-settings'), button = $('#btn-push-toggle'), status = $('#push-status');
  if (!card || !button || !status) return;
  card.classList.toggle('hidden', !admin);
  if (!admin) return;
  button.disabled = false;
  if (isIOSHomeScreenRequired()){
    status.textContent = 'على iPhone أو iPad، أضف التطبيق إلى الشاشة الرئيسية أولًا.';
    button.disabled = true;
    return;
  }
  if (!pushSupported()){
    status.textContent = 'هذا المتصفح أو الاتصال لا يدعم Web Push؛ يلزم HTTPS ومتصفح يدعم الإشعارات.';
    button.disabled = true;
    return;
  }
  if (Notification.permission === 'denied'){
    status.textContent = 'إذن الإشعارات مرفوض. غيّر الإذن من إعدادات المتصفح لهذا الموقع.';
    button.disabled = true;
    return;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription){
      const { error: rpcError } = await sb.rpc('has_push_subscription', { p_endpoint: '' });
      if (rpcError) throw rpcError;
      const { data, error } = await sb.functions.invoke('push-notify', { body: { action: 'public_key' } });
      if (error || !data?.publicKey) throw new Error('خدمة الإشعارات غير مهيأة على الخادم');
      pushVapidPublicKey = data.publicKey;
      status.textContent = 'يمكنك تفعيل إشعارات المتجر على هذا الجهاز.';
      button.textContent = 'تفعيل الإشعارات';
      return;
    }
    pushVapidPublicKey = null;
    const { data: active, error } = await sb.rpc('has_push_subscription', { p_endpoint: subscription.endpoint });
    if (error) throw error;
    status.textContent = active ? 'هذا الجهاز مسجّل لاستقبال إشعارات المدير.' : 'يوجد اشتراك محلي غير مربوط بهذا الحساب.';
    button.textContent = active ? 'إيقاف الإشعارات على هذا الجهاز' : 'تفعيل الإشعارات لهذا الحساب';
  } catch {
    pushVapidPublicKey = null;
    status.textContent = 'خدمة الإشعارات غير مهيأة أو تعذر الوصول إليها؛ لن يُطلب إذن المتصفح قبل جاهزية الخادم.';
    button.textContent = 'غير متاح قبل الإعداد';
    button.disabled = true;
  }
}
function vapidKeyBytes(base64Url){
  const padding = '='.repeat((4 - base64Url.length % 4) % 4);
  const binary = atob((base64Url + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
$('#btn-push-toggle').addEventListener('click', async () => {
  const button = $('#btn-push-toggle');
  if (!admin || !pushSupported()) return;
  if (isIOSHomeScreenRequired()) return toast('أضف التطبيق إلى الشاشة الرئيسية أولًا على iPhone أو iPad', false);
  pushBusy = true; button.disabled = true;
  const oldLabel = button.textContent;
  button.textContent = 'جارٍ تحديث الإعداد…';
  try {
    // اطلب الإذن مباشرة من ضغطة المستخدم، قبل أي انتظار شبكي، خصوصًا على iOS.
    if (Notification.permission === 'default'){
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('لم يُمنح إذن الإشعارات');
    }
    if (Notification.permission !== 'granted') throw new Error('إذن الإشعارات غير متاح');
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (subscription){
      const { data: active, error: statusError } = await sb.rpc('has_push_subscription', { p_endpoint: subscription.endpoint });
      if (statusError) throw statusError;
      if (active){
        const { error: deleteError } = await sb.rpc('delete_push_subscription', { p_endpoint: subscription.endpoint });
        if (deleteError) throw deleteError;
        await subscription.unsubscribe();
        toast('تم إيقاف إشعارات هذا الجهاز');
        return;
      }
    }
    if (!subscription){
      if (!pushVapidPublicKey) throw new Error('خدمة الإشعارات غير مهيأة على الخادم بعد');
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyBytes(pushVapidPublicKey)
      });
    }
    const details = subscription.toJSON();
    if (!details.endpoint || !details.keys?.p256dh || !details.keys?.auth) throw new Error('بيانات اشتراك المتصفح غير مكتملة');
    const { error: saveError } = await sb.rpc('save_push_subscription', {
      p_endpoint: details.endpoint,
      p_p256dh: details.keys.p256dh,
      p_auth: details.keys.auth
    });
    if (saveError){
      await subscription.unsubscribe();
      throw saveError;
    }
    toast('تم تفعيل إشعارات المدير على هذا الجهاز');
  } catch (error){
    const message = error instanceof Error ? error.message : 'خطأ غير معروف';
    toast('تعذر تحديث الإشعارات: ' + message, false);
  } finally {
    pushBusy = false;
    button.textContent = oldLabel;
    await refreshPushSettings();
  }
});
async function pushUnlink(){
  try {
    if (!admin || !pushSupported()) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await sb.rpc('delete_push_subscription', { p_endpoint: sub.endpoint });
    await sub.unsubscribe();
  } catch { /* لا نمنع الخروج */ }
}
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'push-resync' && admin) { pushInit = false; refreshPushSettings(); } });


document.title = STORE_NAME;


let C = [], I = [], Y = [], U = [], admin = false;
let channel = null, timer, loading = false, dirty = false, state = {};
let screen = 'stats';
let detailCustomerId = null;
let imagePreviewUrls = [], imagePreviewHistoryEntry = false, ignoreImagePreviewPop = false;
let editingUserId = null;
const TX = {};            // كشف كامل لكل عميل (يُجلب منفردة حتى لا يُقتطع)
const TX_INV = 'id,total,note,kind,created_at,voided_at,void_reason,edited_at,profiles!invoices_created_by_fkey(name)';
const TX_PAY = 'id,amount,note,created_at,voided_at,void_reason,edited_at,profiles!payments_created_by_fkey(name)';


function toast(msg, ok = true){
  const t = $('#toast'); t.textContent = msg; t.className = ok ? 'ok' : 'err';
  clearTimeout(timer); timer = setTimeout(() => t.className = '', 3500);
}

let dialogResolver = null;
function closeDialog(result = null){
  const modal = $('#dialog-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  $('#dialog-fields').replaceChildren();
  const resolve = dialogResolver;
  dialogResolver = null;
  if (resolve) resolve(result);
}
function openDialog({ title = 'تأكيد', message = '', fields = [], confirmText = 'تأكيد', danger = false } = {}){
  if (dialogResolver) closeDialog(null);
  $('#dialog-title').textContent = title;
  const msgEl = $('#dialog-msg');
  msgEl.textContent = message || '';
  msgEl.classList.toggle('hidden', !message);
  const fieldsBox = $('#dialog-fields');
  fieldsBox.replaceChildren();
  fields.forEach((f, idx) => {
    const lbl = document.createElement('label');
    lbl.textContent = f.label || '';
    const inp = document.createElement(f.multiline ? 'textarea' : 'input');
    inp.name = f.name || `field_${idx}`;
    if (!f.multiline) inp.type = f.type || 'text';
    if (f.inputMode) inp.inputMode = f.inputMode;
    if (f.dir) inp.dir = f.dir;
    if (f.placeholder) inp.placeholder = f.placeholder;
    if (f.min != null) inp.min = String(f.min);
    if (f.step != null) inp.step = String(f.step);
    inp.value = f.value ?? '';
    lbl.appendChild(inp);
    fieldsBox.appendChild(lbl);
  });
  const submitBtn = $('#dialog-submit');
  submitBtn.textContent = confirmText;
  submitBtn.className = danger ? 'btn del' : 'btn';
  $('#dialog-modal').classList.remove('hidden');
  const firstInput = fieldsBox.querySelector('input,textarea');
  if (firstInput) setTimeout(() => { firstInput.focus(); if (firstInput.select) firstInput.select(); }, 20);
  else setTimeout(() => submitBtn.focus(), 20);
  return new Promise(resolve => { dialogResolver = resolve; });
}
$('#dialog-close').onclick = () => closeDialog(null);
$('#dialog-cancel').onclick = () => closeDialog(null);
$('#dialog-modal').addEventListener('click', e => { if (e.target.id === 'dialog-modal') closeDialog(null); });
$('#dialog-form').addEventListener('submit', e => {
  e.preventDefault();
  const out = {};
  $('#dialog-fields').querySelectorAll('input,textarea').forEach(el => { out[el.name] = el.value; });
  closeDialog(out);
});


/* ============ التنقل بين الشاشات ============ */
const TITLES = {
  stats: 'الإحصائيات',
  new: 'فاتورة جديدة',
  customers: 'العملاء',
  customer: 'ملف العميل',
  users: 'المستخدمون'
};
function goTo(name){
  screen = name;
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  const el = $('#screen-' + name);
  if (el) el.classList.remove('hidden');
  $('#screen-title').textContent = TITLES[name] || STORE_NAME;

  // شريط التنقل يظهر فقط على الشاشات الرئيسية
  const isDetail = name === 'customer';
  $('#bottom-nav').classList.toggle('hidden', isDetail);
  $('#btn-back').classList.toggle('hidden', !isDetail);
  document.body.classList.toggle('detail', isDetail);

  document.querySelectorAll('#bottom-nav button').forEach(b =>
    b.classList.toggle('on', b.dataset.screen === name));
  $('main').scrollTop = 0;
  if (name === 'users') loadUsers();
}
document.querySelectorAll('#bottom-nav button').forEach(b => b.onclick = () => goTo(b.dataset.screen));
/* الخروج من ملف العميل: يستهلك مدخل السجل الذي أضافه openCustomer، فيعمل زر الرجوع في الهاتف كزر الشاشة */
function leaveCustomer(){
  if (!detailCustomerId) return;
  detailCustomerId = null;
  if (history.state && history.state.screen === 'customer') history.back();
  else { goTo('customers'); render(); }
}
window.addEventListener('popstate', () => {
  if (ignoreImagePreviewPop){ ignoreImagePreviewPop = false; return; }
  if (imagePreviewHistoryEntry && !$('#img-modal').classList.contains('hidden')) { closeImageModal(true); return; }
  if (screen === 'customer') { detailCustomerId = null; goTo('customers'); render(); }
});
$('#btn-back').onclick = leaveCustomer;


/* ============ الدخول ============ */
$('#btn-login').onclick = async () => {
  const username = $('#username').value.trim(), password = $('#pass').value;
  if (!username || !password) return toast('أدخل اسم المستخدم وكلمة المرور', false);
  const { data: email, error: lookupError } = await sb.rpc('login_email', { p_username: username });
  if (lookupError || !email) return toast('اسم المستخدم أو كلمة المرور غير صحيحة', false);
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) toast('اسم المستخدم أو كلمة المرور غير صحيحة', false);
};
['#username','#pass'].forEach(s => $(s).onkeydown = e => { if (e.key === 'Enter') $('#btn-login').click(); });
$('#btn-out').onclick = async () => {
  await pushUnlink();
  if (channel) { await sb.removeChannel(channel); channel = null; }
  await sb.auth.signOut();
};
let signedIn = false;
sb.auth.onAuthStateChange((_e, session) => {
  $('#login').classList.toggle('hidden', !!session);
  $('#app').classList.toggle('hidden', !session);
  if (session) { if (!signedIn) goTo('stats'); signedIn = true; load(); subscribe(); }
  else {
    closeImageModal();
    closeDialog(null);
    signedIn = false; pushInit = false; $('#push-settings').classList.add('hidden'); C = []; I = []; Y = []; U = []; state = {}; admin = false; detailCustomerId = null;
    for (const k in TX) delete TX[k];
    ['#kpi','#recent-tx','#top-debtors','#customers','#users','#customer-tx','#profile-head'].forEach(s => { const e = $(s); if (e) e.innerHTML = ''; });
    if (channel) { sb.removeChannel(channel); channel = null; }
  }
});


/* ============ التحميل والمزامنة ============ */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function load(){
  if (loading) { dirty = true; return; }
  loading = true;
  let lastError = null;
  try {
    // أخطاء fetch العابرة شائعة على الهاتف عند تبدّل الشبكة؛ أعد المحاولة قبل التنبيه.
    for (let attempt = 0; attempt < 3; attempt++){
      try {
        await loadNow();
        lastError = null;
        break;
      } catch (e){
        lastError = e;
        if (attempt < 2) await wait(500 * (attempt + 1));
      }
    }
    if (lastError) toast('تعذّر الاتصال بالخادم. تحقق من الإنترنت ثم أعد المحاولة', false);
  } finally {
    loading = false;
    if (dirty) { dirty = false; load(); }
  }
}
async function loadNow(){
  const { data:{ session } } = await sb.auth.getSession();
  if (!session) return;
  const [c, i, y, me, s] = await Promise.all([
    sb.from('customer_balances').select('*').order('name'),
    ...feedQueries(),
    sb.from('profiles').select('name,role').eq('id', session.user.id).maybeSingle(),
    sb.from('store_stats').select('*').single()
  ]);
  const err = c.error || i.error || y.error || me.error || s.error;
  if (err) throw err;
  C = [...(c.data || [])].sort((a, b) => coll.compare(a.name || '', b.name || ''));
  I = i.data || []; Y = y.data || []; state = s.data || {};
  admin = me.data?.role === 'admin';
  $('#nav-users').classList.toggle('hidden', !admin);
  $('#credit-limit-field').classList.toggle('hidden', !admin);
  $('#push-settings').classList.toggle('hidden', !admin);
  if (admin && !pushInit) { pushInit = true; refreshPushSettings(); }
  $('#me').textContent = (me.data?.name || '') + (admin ? ' (مدير)' : ' (بائع)');
  render();
  // إن كان ملف عميل مفتوحاً: حدّث كشفه من جديد (دون إفراغ الشاشة)
  if (detailCustomerId) loadTx(detailCustomerId);
}
function subscribe(){
  if (channel) return;
  let t; const again = () => { clearTimeout(t); t = setTimeout(load, 300); };
  channel = sb.channel('live');
  ['invoices','customers','payments'].forEach(tb =>
    channel.on('postgres_changes', { event:'*', schema:'public', table:tb }, again));
  channel.subscribe();
}


/* ============ كشف حساب العميل (يُجلب كاملاً) ============ */
// PostgREST قد يحدّ-rows لكل استجابة، فنقسم على صفحات ونقارن بعدد الصفوف الكلي
const PAGE = 1000;
async function fetchAll(table, cols, customerId){
  const out = []; let from = 0, count = null;
  for (let guard = 0; guard < 1000; guard++){
    const { data, error, count: c } = await sb.from(table)
      .select(cols, { count: 'exact' })
      .eq('customer_id', customerId)
      .order('created_at',{ascending:true}).order('id',{ascending:true})
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (c != null) count = c;
    out.push(...(data || []));
    from += (data || []).length;
    if (!data || !data.length) break;
    if (count != null ? from >= count : data.length < PAGE) break;
  }
  return { rows: out, complete: count == null || out.length >= count };
}

// ترتيب حتمي: الزمن، ثم الفاتورة قبل التسديد، ثم المعرّف.
// (المعرّفات من جدولين مختلفين فلا يصحّ خلطها في مقارنة واحدة)
function cmpStatement(a, b){
  const t = new Date(a.d) - new Date(b.d);
  if (t) return t;
  if (a.src !== b.src) return a.src === 'inv' ? -1 : 1;
  return (a.id || 0) - (b.id || 0);
}

/* مصدر واحد للحقيقة: يبني حركات العميل مرتّبة، مع الرصيد بعد كل حركة
   والإجماليات والرصيد النهائي. تستخدمه الشاشة والطباعة معاً، فلا تختلفان أبداً. */
function buildStatement(invRows, payRows){
  const rows = [
    ...(invRows || []).map(r => {
      const voided = Boolean(r.voided_at);
      return {
        src: 'inv', id: r.id, d: r.created_at, voided, edited: Boolean(r.edited_at),
        type: voided ? 'void' : (r.kind === 'disbursement' ? 'settlement' : 'inv'),
        title: (r.kind === 'disbursement' ? 'فاتورة سداد' : 'فاتورة دين') + ' #' + r.id + (voided ? ' (ملغاة)' : ''),
        note: voided && r.void_reason
          ? (r.note ? r.note + ' — سبب الإلغاء: ' + r.void_reason : 'سبب الإلغاء: ' + r.void_reason)
          : r.note,
        by: r.profiles?.name,
        rawAmt: Number(r.total) || 0,
        debit: voided || r.kind === 'disbursement' ? 0 : Number(r.total) || 0,
        credit: voided || r.kind !== 'disbursement' ? 0 : Number(r.total) || 0
      };
    }),
    ...(payRows || []).map(r => ({
      src: 'pay', id: r.id, d: r.created_at, voided: Boolean(r.voided_at), edited: Boolean(r.edited_at),
      type: r.voided_at ? 'void' : 'pay',
      title: 'إيصال قبض #' + r.id + (r.voided_at ? ' (ملغى)' : ''),
      note: r.voided_at && r.void_reason ? (r.note ? r.note + ' — سبب الإلغاء: ' + r.void_reason : 'سبب الإلغاء: ' + r.void_reason) : r.note,
      by: r.profiles?.name, rawAmt: Number(r.amount) || 0, debit: 0, credit: r.voided_at ? 0 : (Number(r.amount) || 0)
    }))
  ].sort(cmpStatement);

  let running = 0, totalDebit = 0, totalCredit = 0;
  for (const r of rows){
    r.balance = Math.round((running + r.debit - r.credit) * 100) / 100;
    running = r.balance;
    if (!r.voided){ totalDebit += r.debit; totalCredit += r.credit; }
  }
  return { rows, totalDebit: Math.round(totalDebit*100)/100, totalCredit: Math.round(totalCredit*100)/100, finalBalance: running };
}

const txSeq = {};   // رقم أحدث طلب لكل عميل: الرد الأقدم لا يستبدل كشفاً أحدث
async function loadTx(id){
  const key = String(id), seq = txSeq[key] = (txSeq[key] || 0) + 1;
  try {
    const [i, y] = await Promise.all([
      fetchAll('invoices', TX_INV, id),
      fetchAll('payments', TX_PAY, id)
    ]);
    if (txSeq[key] !== seq) return;
    if (!i.complete || !y.complete) toast('كشف الحساب أطول من الحد المسموح — قد ينقص جزء من الحركات', false);
    TX[String(id)] = { st: buildStatement(i.rows, y.rows), inv: i.rows, pay: y.rows };
  } catch (e){
    if (txSeq[key] !== seq) return;
    return toast('تعذّر تحميل كشف الحساب: ' + (e.message || e), false);
  }
  if (String(detailCustomerId) === String(id)) renderCustomerDetail(id);
}
function openCustomer(id){
  history.pushState({ screen: 'customer' }, '');
  detailCustomerId = id;
  renderCustomerDetail(id);
  goTo('customer');
  loadTx(id);
}


/* ============ الرسم ============ */
function render(){
  renderStats();
  renderNewInvoiceSelects();
  renderCustomersList();
  if (detailCustomerId) renderCustomerDetail(detailCustomerId);
}


/* ---- الإحصائيات ---- */
function renderStats(){
  $('#kpi').innerHTML = `
    <div class="wide">إجمالي الديون الصافي<b class="${Number(state.total_debt) >= 0 ? 'debt' : 'ok'}">${fmt(state.total_debt)}</b></div>
    <div>عدد العملاء<b>${state.customers_count || 0}</b></div>
    <div>إجمالي التسديدات<b class="ok">${fmt(state.total_paid)}</b></div>
    <div>صافي حركة اليوم<b class="${Number(state.today_debt) >= 0 ? 'debt' : 'ok'}">${fmt(state.today_debt)}</b></div>
    <div>تسديدات اليوم<b class="ok">${fmt(state.today_paid)}</b></div>
    <div>إجمالي الفواتير<b>${fmt(state.total_invoiced)}</b></div>
    <div>إجمالي فواتير السداد<b>${fmt(state.total_disbursed)}</b></div>
  `;


  renderFeedFilters();
  renderFeed();


  // أعلى 5 مدينين
  const top = [...C].filter(c => Number(c.debt) > 0).sort((a, b) => Number(b.debt) - Number(a.debt)).slice(0, 5);
  $('#top-debtors').innerHTML = top.length ? top.map(c => `
    <div class="cust-card" data-open-customer="${c.id}">
      <div class="top-row">
        <span class="cname">${esc(c.name)}</span>
        <span class="cdebt debt">${fmt(c.debt)}</span>
      </div>
    </div>`).join('')
    : '<div class="empty">لا توجد ديون حالياً.</div>';
}

function renderFeedFilters(){
  const sel = $('#feed-customer');
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = '<option value="">كل العملاء</option>' + C.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  sel.value = keep;
}

function feedRange(){
  const days = Number($('#feed-days')?.value) || 0, selected = $('#feed-date')?.value;
  let from = null, to = null;
  if (selected){
    from = new Date(selected + 'T00:00:00');
    to = new Date(from); to.setDate(to.getDate() + 1);
  } else if (days > 0){
    from = new Date(); from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - (days - 1));
  }
  return { from, to };
}

function feedQueries(){
  const fc = $('#feed-customer')?.value || '', { from, to } = feedRange();
  let qi = sb.from('invoices').select('id,total,note,kind,created_at,voided_at,void_reason,edited_at,customer_id,customers(name),profiles!invoices_created_by_fkey(name)').order('id',{ascending:false}).limit(200);
  let qp = sb.from('payments').select('id,amount,note,created_at,voided_at,void_reason,edited_at,customer_id,customers(name),profiles!payments_created_by_fkey(name)').order('id',{ascending:false}).limit(200);
  for (const f of [q => fc ? q.eq('customer_id', fc) : q, q => from ? q.gte('created_at', from.toISOString()) : q, q => to ? q.lt('created_at', to.toISOString()) : q]) { qi = f(qi); qp = f(qp); }
  return [qi, qp];
}
function renderFeed(){
  const box = $('#recent-tx');
  if (!box) return;
  const customer = $('#feed-customer')?.value || '', type = $('#feed-type')?.value || '';
  const { from, to } = feedRange();
  const inRange = d => { const date = new Date(d); return (!from || date >= from) && (!to || date < to); };
  const rows = [
    ...(type === 'payment' ? [] : I.map(r => ({
      src: 'inv', k: r.voided_at ? 'void' : (r.kind === 'disbursement' ? 'settlement' : 'inv'), kind: r.kind, id: r.id, edited: Boolean(r.edited_at), d: r.created_at,
      cid: r.customer_id, who: r.customers?.name, amt: Number(r.total), by: r.profiles?.name,
      title: (r.kind === 'disbursement' ? 'فاتورة سداد' : 'فاتورة دين') + ' #' + r.id + (r.voided_at ? ' (ملغاة)' : '')
    }))),
    ...(type === 'invoice' || type === 'disbursement' ? [] : Y.map(r => ({
      src: 'pay', k: r.voided_at ? 'void' : 'pay', id: r.id, edited: Boolean(r.edited_at), d: r.created_at, cid: r.customer_id, who: r.customers?.name,
      amt: Number(r.amount), by: r.profiles?.name, title: 'إيصال قبض #' + r.id + (r.voided_at ? ' (ملغى)' : '')
    })))
  ].filter(r => (!customer || r.cid === customer) &&
    (!type || (type === 'payment' ? r.src === 'pay' : type === 'invoice' ? r.kind === 'invoice' : type === 'disbursement' ? r.kind === 'disbursement' : true)) && inRange(r.d))
   .sort((a, b) => new Date(b.d) - new Date(a.d));
  const summary = $('#feed-summary');
  if (summary) summary.textContent = `عدد الحركات المعروضة: ${rows.length} (حتى 200 لكل نوع) · ${from ? (to ? 'التاريخ المحدد' : 'من ' + from.toLocaleDateString('ar')) : 'كل التواريخ'}`;
  box.innerHTML = rows.length ? rows.map(r => txCardHTML(r)).join('') : '<div class="empty">لا توجد حركات مطابقة.</div>';
}

$('#feed-type').onchange = renderFeed;
$('#feed-customer').onchange = load;
$('#feed-days').onchange = () => { if ($('#feed-days').value !== '0') $('#feed-date').value = ''; load(); };
$('#feed-date').onchange = () => { if ($('#feed-date').value) $('#feed-days').value = '0'; load(); };

function findInvoice(id){
  const fromFeed = I.find(x => String(x.id) === String(id));
  if (fromFeed) return fromFeed;
  for (const [cid, entry] of Object.entries(TX)){
    const hit = (entry.inv || []).find(x => String(x.id) === String(id));
    if (hit){
      const cust = C.find(c => String(c.id) === String(cid));
      return { ...hit, customer_id: cid, customers: { name: cust?.name || '—' } };
    }
  }
  return null;
}
function findPayment(id){
  const fromFeed = Y.find(x => String(x.id) === String(id));
  if (fromFeed) return fromFeed;
  for (const [cid, entry] of Object.entries(TX)){
    const hit = (entry.pay || []).find(x => String(x.id) === String(id));
    if (hit){
      const cust = C.find(c => String(c.id) === String(cid));
      return { ...hit, customer_id: cid, customers: { name: cust?.name || '—' } };
    }
  }
  return null;
}
function openInvoice(id){
  const r = findInvoice(id);
  if (!r) return toast('الفاتورة غير موجودة في القائمة الحالية', false);
  const kind = r.kind === 'disbursement' ? 'فاتورة سداد' : 'فاتورة دين';
  $('#movement-modal-title').textContent = kind;
  $('#invoice-detail').innerHTML = `
    <div class="invoice-meta">
      <div>الرقم: <b>${r.id}</b></div><div>النوع: <b>${kind}</b></div>
      <div>العميل: <b>${esc(r.customers?.name || '—')}</b></div><div>البائع: <b>${esc(r.profiles?.name || '—')}</b></div>
      <div>التاريخ: <b>${esc(dt(r.created_at))}</b></div><div>الحالة: <b>${r.voided_at ? 'ملغاة' : 'نشطة'}${r.edited_at ? ' · معدلة' : ''}</b></div>
    </div>
    ${admin && !r.voided_at ? `<div class="card ${r.edited_at ? 'edited' : ''}" style="margin:0 0 10px;background:var(--soft)"><label>قيمة الفاتورة<input id="edit-invoice-amount" type="number" min="0.01" step="0.01" inputmode="decimal" value="${esc(r.total)}"></label></div>` : `<div class="card ${r.edited_at ? 'edited' : ''}" style="margin:0 0 10px;background:var(--soft)"><div class="meta">القيمة</div><div style="font-size:28px;font-weight:800;color:var(${r.kind === 'disbursement' ? '--ok' : '--bad'})">${fmt(r.total)}</div></div>`}
    <div class="card" style="margin:0 0 14px;background:var(--soft)">${admin && !r.voided_at ? `<label>ملاحظة الفاتورة<textarea id="edit-invoice-note">${esc(r.note || '')}</textarea></label>` : `<div class="meta">الملاحظة</div><div style="white-space:pre-wrap">${esc(r.note || '—')}</div>`}
      ${r.voided_at && r.void_reason ? `<div class="meta" style="margin-top:8px">سبب الإلغاء: ${esc(r.void_reason)}</div>` : ''}</div>
    ${!r.voided_at ? `<div class="row2">${admin ? `<button class="btn" data-save-invoice="${r.id}">حفظ التعديل</button>` : '<span></span>'}<button class="btn del" data-void="${r.id}">إلغاء الفاتورة</button></div>` : ''}`;
  $('#invoice-modal').classList.remove('hidden');
}
function openPayment(id){
  const r = findPayment(id);
  if (!r) return toast('التسديد غير موجود في القائمة الحالية', false);
  $('#movement-modal-title').textContent = 'إيصال قبض';
  $('#invoice-detail').innerHTML = `
    <div class="invoice-meta">
      <div>الرقم: <b>${r.id}</b></div><div>النوع: <b>تسديد</b></div>
      <div>العميل: <b>${esc(r.customers?.name || '—')}</b></div><div>البائع: <b>${esc(r.profiles?.name || '—')}</b></div>
      <div>التاريخ: <b>${esc(dt(r.created_at))}</b></div><div>الحالة: <b>${r.voided_at ? 'ملغى' : 'نشط'}${r.edited_at ? ' · معدل' : ''}</b></div>
    </div>
    ${admin && !r.voided_at ? `<div class="card ${r.edited_at ? 'edited' : ''}" style="margin:0 0 10px;background:var(--soft)"><label>قيمة التسديد<input id="edit-payment-amount" type="number" min="0.01" step="0.01" inputmode="decimal" value="${esc(r.amount)}"></label></div>` : `<div class="card ${r.edited_at ? 'edited' : ''}" style="margin:0 0 10px;background:var(--soft)"><div class="meta">القيمة</div><div style="font-size:28px;font-weight:800;color:var(--ok)">${fmt(r.amount)}</div></div>`}
    <div class="card" style="margin:0 0 14px;background:var(--soft)">${admin && !r.voided_at ? `<label>ملاحظة التسديد<textarea id="edit-payment-note">${esc(r.note || '')}</textarea></label>` : `<div class="meta">الملاحظة</div><div style="white-space:pre-wrap">${esc(r.note || '—')}</div>`}${r.voided_at && r.void_reason ? `<div class="meta" style="margin-top:8px">سبب الإلغاء: ${esc(r.void_reason)}</div>` : ''}</div>
    ${!r.voided_at ? `<div class="row2">${admin ? `<button class="btn" data-save-payment="${r.id}">حفظ التعديل</button>` : '<span></span>'}<button class="btn del" data-void-payment="${r.id}">إلغاء التسديد</button></div>` : ''}`;
  $('#invoice-modal').classList.remove('hidden');
}
function closeInvoice(){ $('#invoice-modal').classList.add('hidden'); }


/* ---- اختيارات الفاتورة الجديدة ---- */
function normalizeCustomerSearch(value){
  return String(value ?? '').trim().toLocaleLowerCase('ar')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/^#\s*/, '').trim();
}
function customerMatchesSearch(c, query){
  const q = normalizeCustomerSearch(query);
  if (!q) return true;
  const name = normalizeCustomerSearch(c?.name || '');
  const number = normalizeCustomerSearch(c?.customer_no ?? '');
  return name.includes(q) || (!!number && number.startsWith(q));
}
function customerNoLabel(c){
  const n = Number(c?.customer_no);
  return Number.isSafeInteger(n) && n > 0 ? `#${n}` : '';
}
let customerOptionsOpen = false, customerActiveIndex = -1;
function closeCustomerOptions(){
  customerOptionsOpen = false; customerActiveIndex = -1;
  const box = $('#inv-customer-options'), input = $('#inv-customer-search');
  box.classList.add('hidden'); input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
}
function renderCustomerOptions(){
  const input = $('#inv-customer-search'), box = $('#inv-customer-options');
  if (!customerOptionsOpen){ box.classList.add('hidden'); input.setAttribute('aria-expanded', 'false'); return; }
  const query = normalizeCustomerSearch(input.value);
  const matching = query ? C.filter(c => customerMatchesSearch(c, query)) : C;
  const matches = [...matching].sort((a, b) => {
    const aNo = Number(a.customer_no), bNo = Number(b.customer_no);
    const aValid = Number.isSafeInteger(aNo) && aNo > 0;
    const bValid = Number.isSafeInteger(bNo) && bNo > 0;
    if (aValid && bValid && aNo !== bNo) return aNo - bNo;
    if (aValid !== bValid) return aValid ? -1 : 1;
    return coll.compare(a.name || '', b.name || '');
  });
  box.replaceChildren(); customerActiveIndex = -1; input.removeAttribute('aria-activedescendant');
  if (!matches.length){
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'لا يوجد عميل مطابق للبحث.'; box.appendChild(empty);
  } else matches.forEach((c, index) => {
    const option = document.createElement('div'); option.className = 'customer-option'; option.id = `inv-customer-option-${index}`;
    option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false'); option.dataset.customerOption = String(c.id);
    const no = customerNoLabel(c), name = document.createElement('span'); name.className = 'customer-option-name'; name.textContent = `${c.name || 'عميل بلا اسم'}${no ? ` ${no}` : ''}`;
    const debt = Number(c.debt || 0), amount = document.createElement('span');
    amount.className = 'customer-option-debt' + (debt > 0 ? ' debt' : debt < 0 ? ' credit' : '');
    amount.textContent = fmt(debt);
    option.append(name, amount); box.appendChild(option);
  });
  box.classList.remove('hidden'); input.setAttribute('aria-expanded', 'true');
}
function activateCustomerOption(index){
  const options = [...$('#inv-customer-options').querySelectorAll('[data-customer-option]')];
  if (!options.length) return;
  customerActiveIndex = (index + options.length) % options.length;
  options.forEach((option, i) => option.setAttribute('aria-selected', String(i === customerActiveIndex)));
  const input = $('#inv-customer-search'); input.setAttribute('aria-activedescendant', options[customerActiveIndex].id);
  options[customerActiveIndex].scrollIntoView({ block: 'nearest' });
}
function chooseInvoiceCustomer(id){
  const c = C.find(x => String(x.id) === String(id)); if (!c) return;
  $('#inv-customer').value = String(c.id); $('#inv-customer-search').value = c.name || '';
  closeCustomerOptions(); hint();
}
function renderNewInvoiceSelects(){
  const selected = $('#inv-customer'), input = $('#inv-customer-search');
  const c = C.find(x => String(x.id) === String(selected.value));
  if (c) input.value = c.name || '';
  else if (selected.value){ selected.value = ''; input.value = ''; }
  if (customerOptionsOpen) renderCustomerOptions();
  hint();
}
function hint(){
  const c = C.find(x => String(x.id) === String($('#inv-customer').value)), h = $('#cust-hint');
  if (!c) return h.textContent = '';
  const lim = Number(c.credit_limit), debt = Number(c.debt);
  const balanceText = fmt(debt);
  h.textContent = `${balanceText} · حد الائتمان ${lim > 0 ? fmt(lim) : 'بلا حد'}` + (lim > 0 ? ` · المتاح ${fmt(lim - debt)}` : '');
}
$('#inv-customer-search').addEventListener('focus', () => { customerOptionsOpen = true; renderCustomerOptions(); });
$('#inv-customer-search').addEventListener('input', () => {
  $('#inv-customer').value = ''; hint(); customerOptionsOpen = true; renderCustomerOptions();
});
$('#inv-customer-search').addEventListener('keydown', e => {
  if (e.key === 'Escape' && customerOptionsOpen){ e.preventDefault(); closeCustomerOptions(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    e.preventDefault();
    if (!customerOptionsOpen){ customerOptionsOpen = true; renderCustomerOptions(); }
    const options = $('#inv-customer-options').querySelectorAll('[data-customer-option]');
    if (options.length) activateCustomerOption(customerActiveIndex < 0 ? (e.key === 'ArrowDown' ? 0 : options.length - 1) : customerActiveIndex + (e.key === 'ArrowDown' ? 1 : -1));
    return;
  }
  if (e.key === 'Enter' && customerOptionsOpen){
    const options = [...$('#inv-customer-options').querySelectorAll('[data-customer-option]')];
    const choice = customerActiveIndex >= 0 ? options[customerActiveIndex] : ($('#inv-customer-search').value.trim() ? options[0] : null);
    if (choice){ e.preventDefault(); chooseInvoiceCustomer(choice.dataset.customerOption); }
  }
});
$('#inv-customer-options').addEventListener('click', e => {
  const option = e.target.closest('[data-customer-option]'); if (option) chooseInvoiceCustomer(option.dataset.customerOption);
});
document.addEventListener('pointerdown', e => {
  if (!$('#invoice-customer-picker').contains(e.target)) closeCustomerOptions();
});
document.addEventListener('focusin', e => {
  if (!$('#invoice-customer-picker').contains(e.target)) closeCustomerOptions();
});


/* ---- قائمة العملاء ---- */
function renderCustomersList(){
  // الرصيد السالب يعني فائضاً للعميل، لذلك يُحسب ضمن الإجمالي الصافي.
  $('#total-debt').textContent = fmt(C.reduce((s, c) => s + Number(c.debt || 0), 0));
  const query = normalizeCustomerSearch($('#customer-search')?.value || '');
  const sortMode = $('#customer-sort')?.dataset.mode || 'number';
  const matching = query ? C.filter(c => customerMatchesSearch(c, query)) : C;
  const visible = [...matching].sort((a, b) => {
    const numberDiff = Number(a.customer_no) - Number(b.customer_no);
    if (sortMode === 'debt-desc'){
      const debtDiff = Number(b.debt || 0) - Number(a.debt || 0);
      if (debtDiff) return debtDiff;
    }
    return numberDiff || coll.compare(a.name || '', b.name || '');
  });
  $('#customers').innerHTML = visible.length ? visible.map(c => {
    const debt = Number(c.debt), no = customerNoLabel(c);
    const balanceClass = debt > 0 ? 'debt' : debt < 0 ? 'credit' : 'ok';
    const balanceText = fmt(debt);
    return `<div class="cust-card" data-open-customer="${c.id}">
      <div class="top-row">
        <span class="cname">${esc(c.name)}${no ? ` <bdi dir="ltr">${no}</bdi>` : ''}</span>
        <span class="cdebt ${balanceClass}">${balanceText}</span>
      </div>
      <div class="meta">حد الائتمان: ${Number(c.credit_limit) > 0 ? fmt(c.credit_limit) : 'بلا حد'}</div>
      <div class="meta" style="display:flex;justify-content:space-between;align-items:center">
        <span>اضغط للعرض</span><span class="arrow">‹</span>
      </div>
    </div>`;
  }).join('')
    : (query ? '<div class="empty">لا يوجد عميل مطابق للبحث.</div>' : '<div class="empty">لا يوجد عملاء. أضف أول عميل من شاشة «فاتورة جديدة».</div>');
}

$('#customer-search').oninput = renderCustomersList;
$('#customer-sort').addEventListener('click', () => {
  const button = $('#customer-sort');
  const debtFirst = button.dataset.mode !== 'debt-desc';
  button.dataset.mode = debtFirst ? 'debt-desc' : 'number';
  button.setAttribute('aria-pressed', String(debtFirst));
  button.setAttribute('aria-label', debtFirst
    ? 'الترتيب الحالي: أعلى رصيد دين. اضغط للتبديل إلى الرقم التسلسلي'
    : 'الترتيب الحالي: الرقم التسلسلي. اضغط للتبديل إلى أعلى رصيد دين');
  $('#customer-sort-label').textContent = debtFirst ? 'أعلى دين' : 'الرقم';
  renderCustomersList();
});


/* ---- ملف العميل ---- */
function renderCustomerDetail(id){
  const c = C.find(x => String(x.id) === String(id));
  if (!c) { leaveCustomer(); return; }
  const debt = Number(c.debt), no = customerNoLabel(c);
  const lim = Number(c.credit_limit);


  $('#profile-head').innerHTML = `
    <div class="pname">${esc(c.name)}${no ? ` <bdi dir="ltr">${no}</bdi>` : ''}</div>
    <div class="pbal">${fmt(debt)}</div>
    <div class="pmeta">${lim > 0 ? `حد الائتمان: ${fmt(lim)} · المتاح: ${fmt(lim - debt)}` : 'بلا حد ائتمان'}</div>
    <div class="profile-actions">
      <button class="btn" data-print-statement="${c.id}">حفظ كشف الحساب كصورة</button>
      <button class="btn alt" data-print-full="${c.id}">حفظ الكشف الكامل</button>
      <button class="btn" data-pay="${c.id}">تسديد دفعة</button>
      ${admin ? `<button class="btn" data-rename="${c.id}">تعديل الاسم</button>` : ''}
      ${admin ? `<button class="btn" data-limit="${c.id}">تعديل الحد</button>` : ''}
      ${admin ? `<button class="btn" style="background:rgba(255,255,255,.15);color:#fff;border-color:rgba(255,255,255,.3)" data-del="${c.id}">حذف العميل</button>` : ''}
    </div>`;


  // الكشف يُقرأ من الجلب المنفصل؛ لا يُعرض إلا كاملاً حتى لا يخطئ الرصيد
  const src = TX[String(id)];
  if (!src) {
    $('#customer-tx').innerHTML = '<div class="empty">جارٍ تحميل كشف الحساب…</div>';
    return;
  }

  $('#customer-tx').innerHTML = src.st.rows.length ? [...src.st.rows].reverse().map(r => {
    const amt = r.type === 'pay' || r.type === 'settlement'
      ? `<span style="color:var(--ok)">− ${fmt(r.credit)}</span>`
      : r.voided ? `<span class="hint"><s style="margin-inline-end:4px">${fmt(r.rawAmt)}</s>${r.src === 'pay' ? 'ملغى' : 'ملغاة'}</span>` : `<span style="color:var(--bad)">+ ${fmt(r.debit)}</span>`;
    return `<div class="tx ${r.type === 'pay' ? 'pay' : r.voided ? 'void' : r.type} ${r.edited ? 'edited' : ''}">
      <div class="t1"><span>${esc(r.title)}</span><span>${amt}</span></div>
      <div class="t2"><span>${esc(dt(r.d))}</span><span>${esc(r.by || '—')}</span></div>
      ${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}
      <div class="run"><span>الرصيد بعد الحركة</span><b>${fmt(r.balance)}</b></div>
      ${(!r.voided || r.edited) ? `<div class="actions">
        ${!r.voided ? `<button class="btn alt sm" data-receipt="${r.src}:${r.id}">${r.type === 'inv' ? 'حفظ الفاتورة كصورة' : 'حفظ الإيصال كصورة'}</button>` : ''}
        ${r.src === 'inv' && !r.voided && admin ? `<button class="btn alt sm" data-edit-invoice="${r.id}">تعديل الفاتورة</button>` : ''}
        ${r.src === 'pay' && !r.voided && admin ? `<button class="btn alt sm" data-edit-payment="${r.id}">تعديل التسديد</button>` : ''}
        ${r.src === 'pay' && !r.voided ? `<button class="btn del sm" data-void-payment="${r.id}">إلغاء التسديد</button>` : ''}
        ${r.edited ? `<span class="tag">${r.src === 'pay' ? 'معدل' : 'معدلة'}</span>` : ''}
        ${r.src === 'inv' && !r.voided ? `<button class="btn del sm" data-void="${r.id}">إلغاء الفاتورة</button>` : ''}
      </div>` : ''}
    </div>`;
  }).join('')
    : '<div class="empty">لا توجد حركات لهذا العميل.</div>';
}

/* ============ حفظ كشف الحساب والإيصالات كصور ============ */
const IMG_W = 800, IMG_H = 1130, IMG_SC = 1.5, IMG_FONT = 'Cairo, Tahoma, Arial, sans-serif';
const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const palette = () => ({ main: cssv('--main') || '#0f5c4d', bad: cssv('--bad') || '#b3261e', ok: cssv('--ok') || '#166534', line: cssv('--line') || '#d9dfdc' });
const tripoliDate = (d, dateOnly = false) => dateOnly
  ? new Date(d).toLocaleDateString('ar', { timeZone: 'Africa/Tripoli' })
  : new Date(d).toLocaleString('ar', { timeZone: 'Africa/Tripoli' });
function newCanvas(h){
  const c = document.createElement('canvas'); c.width = IMG_W * IMG_SC; c.height = h * IMG_SC;
  const x = c.getContext('2d');
  if (!x) throw new Error('تعذّر إنشاء لوحة الصورة');
  x.scale(IMG_SC, IMG_SC); x.fillStyle = '#fff'; x.fillRect(0, 0, IMG_W, h); x.direction = 'rtl'; x.textBaseline = 'middle';
  return { c, x };
}
function T(x, s, px, py, o = {}){ x.font = `${o.w || 400} ${o.s || 15}px ${IMG_FONT}`; x.fillStyle = o.col || '#111'; x.textAlign = o.al || 'right'; x.fillText(String(s), px, py); }
function wrapText(x, s, maxW, font, maxLines = 99){
  x.font = font; const out = [];
  String(s).split('\n').forEach(par => { let cur = ''; par.split(/\s+/).forEach(w => { const t = cur ? cur + ' ' + w : w; if (cur && x.measureText(t).width > maxW){ out.push(cur); cur = w; } else cur = t; }); out.push(cur); });
  if (out.length > maxLines){ out.length = maxLines; out[maxLines - 1] += '…'; }
  return out;
}
function rrect(x, rx, ry, w, h, r, fill, stroke){
  x.beginPath(); x.roundRect ? x.roundRect(rx, ry, w, h, r) : x.rect(rx, ry, w, h);
  if (fill){ x.fillStyle = fill; x.fill(); } if (stroke){ x.strokeStyle = stroke; x.lineWidth = 2; x.stroke(); }
}
function drawHead(x, title){
  const p = palette(); rrect(x, 24, 24, IMG_W - 48, 64, 10, p.main);
  T(x, STORE_NAME, IMG_W - 44, 56, { w: 800, s: 24, col: '#fff' });
  T(x, title, 44, 56, { w: 800, s: 20, col: '#fff', al: 'left' });
  return 108;
}
function drawAmountBox(x, bx, y, label, value){
  const p = palette(); rrect(x, bx, y, 240, 84, 12, '#fff', p.main); rrect(x, bx, y, 240, 32, 12, p.main);
  T(x, label, bx + 120, y + 17, { w: 800, s: 14, col: '#fff', al: 'center' });
  T(x, value, bx + 120, y + 58, { w: 900, s: 28, col: p.main, al: 'center' });
}
function drawSign(x, y, stamp){
  if (stamp){ const k = Math.min(180 / stamp.width, 110 / stamp.height); x.drawImage(stamp, IMG_W - 44 - stamp.width * k, y, stamp.width * k, stamp.height * k); }
  x.strokeStyle = '#555'; x.lineWidth = 1; x.beginPath(); x.moveTo(44, y + 90); x.lineTo(284, y + 90); x.stroke();
  T(x, 'توقيع العميل', 164, y + 108, { s: 14, al: 'center' });
}
const loadStamp = () => new Promise(res => {
  const i = new Image(); let done = false;
  const finish = value => { if (done) return; done = true; clearTimeout(timer); res(value); };
  const timer = setTimeout(() => finish(null), 2500);
  i.onload = () => finish(i); i.onerror = () => finish(null); i.src = 'stamp.png';
});
const toBlob = c => new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('تعذّر ترميز الصورة')), 'image/png'));
function closeImageModal(fromPop = false){
  const hadHistoryEntry = imagePreviewHistoryEntry;
  imagePreviewHistoryEntry = false;
  $('#img-modal').classList.add('hidden'); $('#img-list').replaceChildren();
  imagePreviewUrls.forEach(u => URL.revokeObjectURL(u)); imagePreviewUrls = [];
  $('#img-wa').onclick = null; $('#img-save').onclick = null;
  $('#img-wa-help').classList.add('hidden'); $('#img-wa-help').textContent = '';
  if (hadHistoryEntry && !fromPop){ ignoreImagePreviewPop = true; history.back(); }
}
function downloadImage(index){
  const file = document.querySelectorAll('#img-list img')[index], url = imagePreviewUrls[index];
  if (!file || !url) return;
  const a = document.createElement('a'); a.href = url; a.download = file.dataset.filename || 'مستند.png';
  document.body.appendChild(a); a.click(); a.remove();
}
$('#img-close').onclick = closeImageModal;
$('#img-modal').addEventListener('click', e => { if (e.target.id === 'img-modal') closeImageModal(); });
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#dialog-modal').classList.contains('hidden')) return closeDialog(null);
  if (!$('#img-modal').classList.contains('hidden')) return closeImageModal();
  if (!$('#invoice-modal').classList.contains('hidden')) return closeInvoice();
});

const WA_COUNTRY = '218'; // رمز ليبيا للأرقام المحلية؛ الأرقام الدولية تُحفظ كما هي.
function waNumber(phone){
  const raw = String(phone || '').trim();
  let d = raw.replace(/[٠-٩]/g, n => String('٠١٢٣٤٥٦٧٨٩'.indexOf(n)))
    .replace(/[۰-۹]/g, n => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(n))).replace(/\D/g, '');
  if (!d) return '';
  const international = raw.startsWith('+') || d.startsWith('00');
  if (d.startsWith('00')) d = d.slice(2);
  if (international && d.startsWith('0')) return '';
  if (!international && d.startsWith('0')) d = WA_COUNTRY + d.slice(1);
  else if (!international && !d.startsWith(WA_COUNTRY) && d.length <= 10) return '';
  return d.length >= 8 && d.length <= 15 ? d : '';
}

async function showImages(blobs, name, { phone = '', text = '' } = {}){
  const safe = String(name).replace(/[\\/:*?"<>|]/g, '').trim() || 'مستند';
  const files = blobs.map((blob, i) => new File([blob], `${safe}${blobs.length > 1 ? '-' + (i + 1) : ''}.png`, { type: 'image/png' }));
  closeImageModal();
  imagePreviewUrls = files.map(f => URL.createObjectURL(f));
  const list = $('#img-list');
  files.forEach((file, i) => {
    const card = document.createElement('article'); card.className = 'img-page';
    const img = document.createElement('img'); img.src = imagePreviewUrls[i]; img.alt = `${safe} — الصفحة ${i + 1}`; img.dataset.filename = file.name; img.loading = 'lazy';
    card.appendChild(img);
    if (files.length > 1){
      const actions = document.createElement('div'); actions.className = 'img-page-actions';
      const label = document.createElement('span'); label.textContent = `الصفحة ${i + 1} من ${files.length}`;
      const link = document.createElement('a'); link.className = 'btn alt sm'; link.href = imagePreviewUrls[i]; link.download = file.name; link.textContent = 'حفظ الصورة';
      actions.append(label, link); card.appendChild(actions);
    }
    list.appendChild(card);
  });
  const wa = $('#img-wa'), save = $('#img-save'), shareText = String(text || safe); let canShare = false;
  try { canShare = !!navigator.share && !!navigator.canShare && navigator.canShare({ files }); } catch { canShare = false; }
  save.classList.toggle('hidden', files.length !== 1);
  const actionBar = document.querySelector('#img-modal .img-actions'), visibleActions = 1 + Number(files.length === 1);
  actionBar.classList.toggle('hidden', visibleActions === 0); actionBar.classList.toggle('single', visibleActions === 1);
  wa.onclick = async () => {
    if (canShare){
      try { await navigator.share({ files, title: safe, text: shareText }); }
      catch (err) { if (err?.name !== 'AbortError') { $('#img-wa-help').textContent = 'تعذّرت المشاركة المباشرة؛ احفظ الصورة وأرفقها يدويًا في واتساب.'; $('#img-wa-help').classList.remove('hidden'); } }
      return;
    }
    const number = waNumber(phone), target = number ? `https://wa.me/${number}` : 'https://wa.me/';
    if (files.length === 1) downloadImage(0);
    window.open(`${target}?text=${encodeURIComponent(shareText)}`, '_blank', 'noopener,noreferrer');
    const recipientHint = number ? '' : ' لم نتمكن من تحديد رقم دولي؛ اختر جهة الاتصال يدويًا.';
    $('#img-wa-help').textContent = (files.length === 1
      ? 'فتحنا واتساب وبدأ حفظ الصورة؛ أرفقها في المحادثة قبل الإرسال.'
      : 'فتحنا واتساب برسالة جاهزة؛ احفظ كل صفحة من زرها أسفل الصورة ثم أرفقها قبل الإرسال.') + recipientHint;
    $('#img-wa-help').classList.remove('hidden');
  };
  save.onclick = () => downloadImage(0);
  $('#img-modal-title').textContent = safe;
  try {
    const current = history.state && typeof history.state === 'object' ? history.state : {};
    history.pushState({ ...current, imagePreview: true }, ''); imagePreviewHistoryEntry = true;
  } catch { imagePreviewHistoryEntry = false; }
  $('#img-modal').classList.remove('hidden');
}

/* يبدأ الكشف المختصر بعد آخر حركة دائنة أغلقت الدين؛ لا يغيّر هذا الحساب الأصلي أو بياناته. */
function sinceSettlement(st){
  let cut = -1;
  st.rows.forEach((r, i) => { if (!r.voided && r.credit > 0 && r.balance <= 0) cut = i; });
  if (cut < 0) return { ...st, periodStart: null };
  const settlement = st.rows[cut];
  const opening = {
    src: 'opening', id: null, d: settlement.d, voided: false, edited: false,
    type: 'opening', title: 'رصيد مرحّل بعد آخر تسوية', note: null, by: '—',
    debit: 0, credit: 0, balance: settlement.balance
  };
  return { ...st, rows: [opening, ...st.rows.slice(cut + 1)], periodStart: settlement.d };
}

async function printStatement(customerId, btn, full = false){
  btn = btn || document.querySelector(full ? `[data-print-full="${customerId}"]` : `[data-print-statement="${customerId}"]`);
  const label = full ? 'حفظ الكشف الكامل' : 'حفظ كشف الحساب كصورة';
  if (btn) { btn.disabled = true; btn.textContent = 'جارٍ التجهيز…'; }
  try {
    const [cRes, iRes, yRes] = await Promise.all([
      sb.from('customers').select('id,name,phone,customer_no').eq('id', customerId).single(),
      fetchAll('invoices', TX_INV, customerId), fetchAll('payments', TX_PAY, customerId)
    ]);
    if (cRes.error) return toast('تعذّر تجهيز كشف الحساب: ' + (cRes.error.message || 'خطأ غير معروف'), false);
    if (!cRes.data) return toast('العميل غير موجود', false);
    if (!iRes.complete || !yRes.complete) return toast('تعذّر جلب كشف الحساب كاملاً — لم تُنشأ الصور', false);
    const completeStatement = buildStatement(iRes.rows, yRes.rows);
    const st = full ? completeStatement : sinceSettlement(completeStatement);
    const reportTitle = full ? 'كشف حساب كامل' : st.periodStart ? 'كشف حساب منذ آخر تسوية' : 'كشف حساب';
    const customer = cRes.data;
    const customerLabel = [customer.name, customerNoLabel(customer)].filter(Boolean).join(' ');
    const p = palette();
    if (document.fonts?.ready) await document.fonts.ready;
    const stamp = await loadStamp(), cols = [290, 120, 100, 110, 132];
    const probe = newCanvas(10).x, noteFont = `400 14px ${IMG_FONT}`;
    const rowHeight = r => Math.max(36, wrapText(probe, r.title + (r.note ? ' — ' + r.note : ''), cols[0] - 14, noteFont, 3).length * 20 + 16);
    let total = 1, estimateY = 282;
    if (!st.rows.length) estimateY += 60;
    for (const r of st.rows){
      const rh = rowHeight(r);
      if (estimateY + rh > IMG_H - 50){ total++; estimateY = 154; }
      estimateY += rh;
    }
    if (estimateY + 270 > IMG_H - 30) total++;

    const blobs = []; let pg = null, x, y;
    const finishPage = async () => {
      const g = pg.x; g.setTransform(IMG_SC, 0, 0, IMG_SC, 0, 0); g.direction = 'rtl';
      T(g, `صفحة ${blobs.length + 1} من ${total}`, IMG_W / 2, IMG_H - 20, { s: 12, col: '#6b7280', al: 'center' });
      blobs.push(await toBlob(pg.c)); pg.c.width = 0; pg.c.height = 0; pg = null;
    };
    const begin = async (first, table = true) => {
      if (pg) await finishPage();
      pg = newCanvas(IMG_H); x = pg.x; y = drawHead(x, reportTitle) + 8;
      if (first){
        [`العميل: ${customerLabel}`, `الهاتف: ${customer.phone || '—'}`, `الرصيد الحالي: ${fmt(st.finalBalance)}`, `تاريخ الإصدار: ${tripoliDate(new Date())}`]
          .forEach(s => { T(x, s, IMG_W - 44, y + 14, { s: 16 }); y += 30; });
        y += 8;
      }
      if (table){
        rrect(x, 24, y, IMG_W - 48, 32, 6, p.main); let cx = IMG_W - 24;
        ['الملاحظة', 'القيمة', 'التاريخ', 'البائع', 'الرصيد'].forEach((h, i) => { T(x, h, cx - cols[i] / 2, y + 17, { w: 800, s: 14, col: '#fff', al: 'center' }); cx -= cols[i]; });
        y += 38;
      }
    };
    await begin(true);
    if (!st.rows.length){ T(x, 'لا توجد حركات', IMG_W / 2, y + 30, { s: 16, col: '#6b7280', al: 'center' }); y += 60; }
    for (const [i, r] of st.rows.entries()){
      const lines = wrapText(probe, r.title + (r.note ? ' — ' + r.note : ''), cols[0] - 14, noteFont, 3), rh = rowHeight(r);
      if (y + rh > IMG_H - 50) await begin(false);
      if (i % 2) { x.fillStyle = '#eef4f1'; x.fillRect(24, y, IMG_W - 48, rh); }
      const col = r.voided ? '#6b7280' : '#111', mid = y + rh / 2;
      lines.forEach((s, k) => T(x, s, IMG_W - 32, y + 18 + k * 20, { s: 14, col }));
      const isIn = r.type === 'pay' || r.type === 'settlement';
      const val = r.voided || r.type === 'opening' ? '—' : isIn ? '− ' + fmt(r.credit) : '+ ' + fmt(r.debit);
      let cx = IMG_W - 24 - cols[0];
      [[val, r.voided || r.type === 'opening' ? col : isIn ? p.ok : p.bad, 800], [tripoliDate(r.d, true), col, 400], [r.by || '—', col, 400], [fmt(r.balance), col, 400]]
        .forEach(([s, color, w], k) => { T(x, s, cx - cols[k + 1] / 2, mid, { s: 14, col: color, w, al: 'center' }); cx -= cols[k + 1]; });
      x.strokeStyle = p.line; x.lineWidth = 1; x.beginPath(); x.moveTo(24, y + rh); x.lineTo(IMG_W - 24, y + rh); x.stroke(); y += rh;
    }
    if (y + 270 > IMG_H - 30) await begin(false, false);
    y += 24; drawAmountBox(x, IMG_W - 24 - 240, y, 'الرصيد النهائي', fmt(st.finalBalance)); drawSign(x, y + 110, stamp);
    await finishPage();
    await showImages(blobs, `${customerLabel} - ${reportTitle}`, {
      phone: customer.phone,
      text: `${STORE_NAME} — ${reportTitle} ${customerLabel}، الرصيد الحالي ${fmt(st.finalBalance)}`
    });
  } catch (err) {
    toast('تعذّر تجهيز كشف الحساب: ' + (err?.message || err), false);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

async function printReceipt(src, id){
  const cid = String(detailCustomerId), c = C.find(x => String(x.id) === cid);
  const r = TX[cid]?.st.rows.find(x => x.src === src && String(x.id) === String(id));
  if (!c || !r || r.voided) return toast('تعذّر تجهيز الإيصال', false);
  try {
    let phone = c.phone || '';
    if (!phone){ try { const { data } = await sb.from('customers').select('phone').eq('id', cid).maybeSingle(); phone = data?.phone || ''; } catch {} }
    if (document.fonts?.ready) await document.fonts.ready;
    const stamp = await loadStamp(), isIn = r.src === 'pay' || r.type === 'settlement';
    const title = r.type === 'settlement' ? 'فاتورة سداد' : r.src === 'pay' ? 'إيصال قبض' : 'فاتورة دين';
    const rows = [`الرقم: ${r.id}`, `التاريخ: ${tripoliDate(r.d)}`, `العميل: ${c.name}`, `البائع: ${r.by || '—'}`, `الرصيد بعد الحركة: ${fmt(r.balance)}`];
    const note = r.note ? wrapText(newCanvas(10).x, 'البيان: ' + r.note, IMG_W - 88, `400 17px ${IMG_FONT}`) : [];
    const n = rows.length + note.length, pg = newCanvas(500 + n * 36), x = pg.x;
    let y = drawHead(x, title) + 20;
    [...rows, ...note].forEach(s => { T(x, s, IMG_W - 44, y + 18, { s: 17 }); y += 36; });
    y += 20; drawAmountBox(x, (IMG_W - 240) / 2, y, 'المبلغ', fmt(isIn ? r.credit : r.debit));
    T(x, isIn ? 'طُرح المبلغ المذكور من رصيد الحساب.' : 'أضيف المبلغ المذكور أعلاه إلى دين العميل.', IMG_W - 44, y + 116, { s: 16 });
    drawSign(x, y + 150, stamp);
    const blob = await toBlob(pg.c); pg.c.width = 0; pg.c.height = 0;
    await showImages([blob], `${c.name} - ${title} ${r.id}`, {
      phone,
      text: `${STORE_NAME} — ${title} رقم ${r.id} بمبلغ ${fmt(isIn ? r.credit : r.debit)}`
    });
  } catch (err) { toast('تعذّر تجهيز الإيصال: ' + (err?.message || err), false); }
}


/* ---- بطاقة حركة مختصرة (للإحصائيات) ---- */
function txCardHTML(r){
  const amtClass = r.k === 'pay' || r.k === 'settlement' ? 'style="color:var(--ok)"' : r.k === 'void' ? '' : 'style="color:var(--bad)"';
  const sign = r.k === 'pay' || r.k === 'settlement' ? '− ' : r.k === 'void' ? '' : '+ ';
  const clickable = r.id != null;
  const seller = r.by ? ` · البائع: ${esc(r.by)}` : (r.k !== 'pay' ? ' · البائع: —' : '');
  const target = r.src === 'pay' ? 'data-open-payment' : 'data-open-invoice';
  return `<div class="tx ${r.k} ${r.edited ? 'edited' : ''}" ${clickable ? `${target}="${r.id}" style="cursor:pointer"` : ''}>
    <div class="t1"><span>${esc(r.who || '—')}</span><span ${amtClass}>${sign}${fmt(r.amt)}</span></div>
    <div class="t2"><span>${esc(r.title)}${seller}</span><span>${esc(dt(r.d))}</span></div>
  </div>`;
}


/* ============ النقر على البطاقات والأزرار ============ */
document.addEventListener('click', async e => {
  const btn = e.target.closest('button');   // الزر الذي بدأ العملية؛ يُعطَّل داخل run() حتى تنتهي
  if (e.target.closest('[data-close-invoice]') || e.target === $('#invoice-modal')) return closeInvoice();
  const invoiceCard = e.target.closest('[data-open-invoice]');
  if (invoiceCard && !e.target.closest('button')) return openInvoice(invoiceCard.dataset.openInvoice);
  const paymentCard = e.target.closest('[data-open-payment]');
  if (paymentCard && !e.target.closest('button')) return openPayment(paymentCard.dataset.openPayment);
  const open = e.target.closest('[data-open-customer]');
  if (open && !e.target.closest('button')) return openCustomer(open.dataset.openCustomer);

  const g = a => e.target.closest(`[data-${a}]`)?.dataset[a.replace(/-./g, m => m[1].toUpperCase())];
  let v;
  if ((v = g('print-full'))) return printStatement(v, e.target.closest('[data-print-full]'), true);
  if ((v = g('print-statement'))) return printStatement(v, e.target.closest('[data-print-statement]'));
  if ((v = g('receipt'))) { const [s, id] = v.split(':'); return printReceipt(s, id); }
  if ((v = g('pay'))) {
    const c = C.find(x => String(x.id) === String(v));
    if (!c) return;
    const res = await openDialog({
      title: 'تسديد دفعة',
      message: `العميل: ${c.name} · الرصيد الحالي: ${fmt(c.debt)}`,
      confirmText: 'حفظ التسديد',
      fields: [
        { name: 'amount', label: 'المبلغ المستلَم', value: Number(c.debt) > 0 ? fmt(c.debt) : '', inputMode: 'decimal', dir: 'ltr', placeholder: '0.00' },
        { name: 'note', label: 'ملاحظة التسديد (اختياري)', value: '', placeholder: 'بيان أو ملاحظة اختيارية' }
      ]
    });
    if (!res) return;
    const rawAmount = String(res.amount ?? '').trim()
      .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
      .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
      .replace(/٫/g, '.');
    if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(rawAmount)) return toast('أدخل مبلغاً صحيحاً', false);
    const m = Number(rawAmount);
    if (!(m > 0 && m < 10000000)) return toast('أدخل مبلغاً صحيحاً', false);
    const n = String(res.note ?? '').trim();
    return run(btn, sb.rpc('add_payment', { p_customer: v, p_amount: m, p_note: n || null }), 'تم تسجيل التسديد');
  }
  if ((v = g('limit'))) {
    const c = C.find(x => String(x.id) === String(v));
    if (!c) return;
    const res = await openDialog({
      title: 'تعديل حد الائتمان',
      message: `العميل: ${c.name}`,
      confirmText: 'حفظ الحد',
      fields: [
        { name: 'limit', label: 'حد الائتمان الجديد (0 = بلا حد)', value: String(c.credit_limit ?? 0), inputMode: 'decimal', dir: 'ltr' }
      ]
    });
    if (!res) return;
    const nextLimit = num(res.limit);
    if (!(nextLimit >= 0 && nextLimit < 10000000)) return toast('قيمة غير صحيحة', false);
    return run(btn, sb.from('customers').update({ credit_limit: Math.round(nextLimit * 100) / 100 }).eq('id', v), 'تم تعديل الحد');
  }
  if ((v = g('rename'))) {
    const c = C.find(x => String(x.id) === String(v));
    if (!c) return;
    const res = await openDialog({
      title: 'تعديل اسم العميل',
      confirmText: 'حفظ الاسم',
      fields: [
        { name: 'name', label: 'الاسم الجديد للعميل', value: c.name || '' }
      ]
    });
    if (!res) return;
    const n = String(res.name ?? '').trim();
    if (!n) return toast('الاسم غير صحيح', false);
    return run(btn, sb.rpc('rename_customer', { p_id: v, p_name: n }), 'تم تعديل الاسم');
  }
  if ((v = g('del'))) {
    const c = C.find(x => String(x.id) === String(v));
    if (!c) return;
    const res = await openDialog({
      title: 'حذف العميل',
      message: `حذف العميل «${c.name}» نهائياً؟
لا يُحذف إلا عميل بلا أي حركات مسجّلة.`,
      confirmText: 'حذف العميل',
      danger: true
    });
    if (!res) return;
    return run(btn, sb.rpc('delete_customer', { p_id: v }), 'تم حذف العميل', leaveCustomer);
  }
  if ((v = g('edit-invoice'))) return openInvoice(v);
  if ((v = g('void'))) {
    const res = await openDialog({
      title: `إلغاء الفاتورة #${v}`,
      message: 'سيعاد حساب رصيد العميل بناءً على إلغاء هذه الفاتورة.',
      confirmText: 'تأكيد الإلغاء',
      danger: true,
      fields: [
        { name: 'reason', label: 'سبب الإلغاء (اختياري)', value: '', placeholder: 'اكتب سبب الإلغاء إن وجد' }
      ]
    });
    if (!res) return;
    const why = String(res.reason ?? '').trim();
    return run(btn, sb.rpc('void_invoice', { p_id: Number(v), p_reason: why || null }), 'تم إلغاء الفاتورة', closeInvoice);
  }
  if ((v = g('save-invoice'))) {
    const rawAmount = String($('#edit-invoice-amount')?.value ?? '').trim()
      .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
      .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
      .replace(/٫/g, '.');
    if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(rawAmount)) return toast('القيمة غير صحيحة', false);
    const m = Number(rawAmount);
    if (!(m > 0 && m < 10000000)) return toast('القيمة غير صحيحة', false);
    const note = $('#edit-invoice-note')?.value || '';
    const res = await openDialog({
      title: `تعديل الفاتورة #${v}`,
      message: `تأكيد حفظ تعديل الفاتورة #${v} بقيمة ${fmt(m)}؟`,
      confirmText: 'حفظ التعديل'
    });
    if (!res) return;
    return run(btn, sb.rpc('update_debt_invoice', { p_id: Number(v), p_amount: m, p_note: note.trim() || null }), 'تم تعديل الفاتورة', closeInvoice);
  }
  if ((v = g('edit-payment'))) return openPayment(v);
  if ((v = g('void-payment'))) {
    const res = await openDialog({
      title: `إلغاء التسديد #${v}`,
      message: 'سيعاد حساب رصيد العميل بناءً على إلغاء هذا التسديد.',
      confirmText: 'تأكيد الإلغاء',
      danger: true,
      fields: [
        { name: 'reason', label: 'سبب الإلغاء (اختياري)', value: '', placeholder: 'اكتب سبب الإلغاء إن وجد' }
      ]
    });
    if (!res) return;
    const why = String(res.reason ?? '').trim();
    return run(btn, sb.rpc('void_payment', { p_id: Number(v), p_reason: why || null }), 'تم إلغاء التسديد', closeInvoice);
  }
  if ((v = g('save-payment'))) {
    const rawAmount = String($('#edit-payment-amount')?.value ?? '').trim()
      .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
      .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
      .replace(/٫/g, '.');
    if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(rawAmount)) return toast('القيمة غير صحيحة', false);
    const m = Number(rawAmount);
    if (!(m > 0 && m < 10000000)) return toast('القيمة غير صحيحة', false);
    const note = $('#edit-payment-note')?.value || '';
    const res = await openDialog({
      title: `تعديل التسديد #${v}`,
      message: `تأكيد حفظ تعديل التسديد #${v} بقيمة ${fmt(m)}؟`,
      confirmText: 'حفظ التعديل'
    });
    if (!res) return;
    return run(btn, sb.rpc('update_payment', { p_id: Number(v), p_amount: m, p_note: note.trim() || null }), 'تم تعديل التسديد', closeInvoice);
  }
  if ((v = g('edit-user'))) {
    const u = U.find(x => String(x.id) === String(v)); if (!u) return;
    editingUserId = u.id;
    $('#user-form-title').textContent = 'تعديل مستخدم';
    $('#btn-save-user').textContent = 'حفظ التعديل';
    $('#btn-cancel-user').classList.remove('hidden');
    $('#u-username').value = u.username;
    $('#u-name').value = u.name;
    $('#u-role').value = u.role;
    $('#u-password').value = '';
    $('main').scrollTop = 0;
  }
});


/* ============ الحفظ والعمل ============ */
async function run(btn, p, okMsg, after){
  if (btn) btn.disabled = true;
  try {
    const { error } = await p;
    if (error) return toast(error.message, false);
    toast(okMsg);
    await load();
    if (typeof after === 'function') after();
  } finally {
    if (btn) btn.disabled = false;
  }
}


$('#inv-kind').onchange = hint;

$('#inv-keypad').addEventListener('pointerdown', e => {
  if (e.target.closest('button')) e.preventDefault();
});
$('#inv-keypad').addEventListener('click', e => {
  const button = e.target.closest('button');
  if (!button) return;
  const input = $('#inv-amount'), value = input.value;
  let start = input.selectionStart ?? value.length, end = input.selectionEnd ?? value.length;
  let insertion = button.dataset.amountKey;
  if (button.dataset.amountAction === 'backspace') {
    if (start === end && start > 0) start--;
    input.value = value.slice(0, start) + value.slice(end);
  } else {
    if (button.dataset.amountAction === 'decimal') {
      if (value.includes('.')) return;
      insertion = start === 0 && end === 0 ? '0.' : '.';
    }
    if (!insertion) return;
    const next = value.slice(0, start) + insertion + value.slice(end);
    const decimalAt = next.indexOf('.');
    if (decimalAt >= 0 && next.length - decimalAt - 1 > 2) return;
    if ((decimalAt >= 0 ? decimalAt : next.length) > 7) return;
    input.value = next;
    start += insertion.length;
  }
  input.focus({ preventScroll: true });
  input.setSelectionRange(start, start);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

$('#btn-save').onclick = async () => {
  const customer = $('#inv-customer').value;
  const rawAmount = String($('#inv-amount').value ?? '').trim()
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/٫/g, '.');
  if (!customer) return toast('اختر العميل', false);
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(rawAmount)) return toast('أدخل قيمة صحيحة', false);
  const amount = Number(rawAmount);
  if (!(amount > 0 && amount < 10000000)) return toast('أدخل قيمة صحيحة', false);
  const b = $('#btn-save'); b.disabled = true;
  const kind = $('#inv-kind').value;
  const { data, error } = await sb.rpc('create_debt_invoice', {
    p_customer: customer, p_amount: amount, p_note: $('#inv-note').value, p_kind: kind
  });
  b.disabled = false;
  if (error) return toast(error.message, false);
  toast((kind === 'disbursement' ? 'تم حفظ فاتورة السداد رقم ' : 'تم حفظ فاتورة الدين رقم ') + data);
  $('#inv-amount').value = ''; $('#inv-note').value = '';
  load();
};


$('#btn-add-c').onclick = async () => {
  const name = $('#c-name').value.trim(), credit_limit = num($('#c-limit').value) || 0;
  if (!name) return toast('أدخل اسم العميل', false);
  const { error } = await sb.from('customers').insert({ name, credit_limit });
  if (error) return toast(error.message, false);
  $('#c-name').value = ''; $('#c-limit').value = 0;
  toast('تمت إضافة العميل'); load();
};


/* ============ إدارة المستخدمين ============ */
async function adminCall(body){
  const result = await sb.functions.invoke('user-admin', { body });
  if (!result.error) return result;
  let message = result.error.message || 'خطأ غير معروف';
  try {
    const ctx = result.error.context;
    if (ctx) {
      const res = typeof ctx.clone === 'function' ? ctx.clone() : ctx;
      if (typeof res.text === 'function') {
        const text = await res.text();
        if (text) {
          try {
            const detail = JSON.parse(text);
            if (detail?.error) message = detail.error;
            else if (detail?.message) message = detail.message;
          } catch (_) {
            if (/non-2xx/i.test(message)) message = text.slice(0, 200);
          }
        }
      }
    }
  } catch (_) {}
  const dict = {
    'Password should be at least 6 characters': 'كلمة المرور يجب أن تكون 6 أحرف على الأقل',
    'Password is known to be weak and easy to guess': 'كلمة المرور ضعيفة أو مسرّبة، اختر كلمة أخرى',
    'User already registered': 'اسم المستخدم مستخدم بالفعل',
    'A user with this email address has already been registered': 'اسم المستخدم مستخدم بالفعل',
    'Unable to validate email address': 'اسم المستخدم يحتوي أحرفاً غير صحيحة'
  };
  for (const [en, ar] of Object.entries(dict)) if (message.includes(en)) { message = ar; break; }
  return { data: { error: message }, error: null };
}


async function loadUsers(){
  if (!admin) return;
  const { data } = await adminCall({ action: 'list' });
  if (data?.error) return toast(data.error, false);
  U = data.users || [];
  $('#users').innerHTML = U.length ? U.map(u => `
    <div class="cust-card" style="cursor:default">
      <div class="top-row">
        <div style="flex:1;min-width:0">
          <div class="cname">${esc(u.name || u.username)}</div>
          <div class="meta">@${esc(u.username)} · ${u.role === 'admin' ? 'مدير' : 'بائع'}</div>
        </div>
        <button class="btn alt sm" data-edit-user="${u.id}">تعديل</button>
      </div>
    </div>`).join('')
    : '<div class="empty">لا يوجد مستخدمون.</div>';
}
function resetUserForm(){
  editingUserId = null;
  $('#user-form-title').textContent = 'إضافة مستخدم';
  $('#btn-save-user').textContent = 'إضافة المستخدم';
  $('#btn-cancel-user').classList.add('hidden');
  $('#u-username').value = ''; $('#u-name').value = ''; $('#u-role').value = 'seller'; $('#u-password').value = '';
}
$('#btn-save-user').onclick = async () => {
  const password = $('#u-password').value;
  const username = $('#u-username').value.trim();
  const name = $('#u-name').value.trim();
  const isNew = !editingUserId;

  if (!/^[\p{L}\p{N}_-]{2,40}$/u.test(username))
    return toast('اسم المستخدم: حرفان على الأقل، وبدون مسافات', false);
  if (!name)
    return toast('أدخل الاسم الظاهر', false);
  if (password && password.length < 6)
    return toast('كلمة المرور يجب أن تكون 6 أحرف على الأقل', false);
  if (isNew && !password)
    return toast('أدخل كلمة المرور', false);

  const body = { action: isNew ? 'create' : 'update', username,
    name, role: $('#u-role').value, password };
  if (!isNew) body.id = editingUserId;
  const b = $('#btn-save-user'); b.disabled = true;
  const { data } = await adminCall(body);
  b.disabled = false;
  if (data?.error) return toast(data.error, false);
  toast(isNew ? 'تمت إضافة المستخدم' : 'تم تعديل المستخدم');
  resetUserForm(); loadUsers();
};
$('#btn-cancel-user').onclick = resetUserForm;