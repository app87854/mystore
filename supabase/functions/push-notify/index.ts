// نشر: supabase functions deploy push-notify --no-verify-jwt
// الأسرار: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:...), PUSH_WEBHOOK_SECRET (32+ حرفاً)
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-push-webhook-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

type SubscriptionRow = { user_id: string; endpoint: string; p256dh: string; auth: string };
type WebhookPayload = { type?: string; schema?: string; table?: string; action?: string; record?: { id?: number | string } };
type Outcome = { ok: boolean; info: string };

const serviceUrl = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const adminClient = serviceUrl && serviceRoleKey
  ? createClient<any>(serviceUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
type Client = NonNullable<typeof adminClient>;

// نطاقات خدمات الدفع المعروفة فقط (يمنع توجيه الخادم إلى عناوين عشوائية)
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];
function allowedEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((r) => r.test(u.hostname));
  } catch { return false; }
}

// مقارنة ثابتة الزمن
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const A = new Uint8Array(x), B = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}

async function markProcessed(client: Client, eventId: number) {
  const { error } = await client.from("push_events")
    .update({ processed_at: new Date().toISOString() }).eq("id", eventId).is("processed_at", null);
  if (error) throw error;
}

async function getAdminSubscriptions(client: Client): Promise<SubscriptionRow[]> {
  const { data: admins, error: adminError } = await client.from("profiles").select("id").eq("role", "admin");
  if (adminError) throw adminError;
  const ids = (admins ?? []).map((row: { id: string }) => row.id);
  if (!ids.length) return [];
  const { data, error } = await client.from("push_subscriptions")
    .select("user_id,endpoint,p256dh,auth").in("user_id", ids);
  if (error) throw error;
  return (data ?? []) as SubscriptionRow[];
}

// اختبار يدوي من لوحة Supabase: رسالة واضحة، ولا يكتب إلى قاعدة البيانات.
async function sendTestNotification(client: Client): Promise<Response> {
  const subscriptions = await getAdminSubscriptions(client);
  if (!subscriptions.length) return json({ ok: false, info: "no-subscribers" }, 409);

  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "";
  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    return json({ ok: false, info: "vapid-not-configured" }, 503);
  }

  const payloadText = JSON.stringify({
    title: "اختبار إشعار MyStore",
    body: "تم إرسال هذه الرسالة للتحقق من عمل الإشعارات.",
    tag: `mystore-test-${crypto.randomUUID()}`,
    url: "./",
  });
  const results = await Promise.all(subscriptions.map(async (s): Promise<string> => {
    if (!allowedEndpoint(s.endpoint)) return "invalid-endpoint";
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payloadText, {
        TTL: 120, urgency: "normal",
        vapidDetails: { subject: vapidSubject, publicKey: vapidPublicKey, privateKey: vapidPrivateKey },
      });
      return "sent";
    } catch (error) {
      const status = Number((error as { statusCode?: number })?.statusCode ?? 0);
      console.warn("Test push delivery failed", { status });
      if (status === 404 || status === 410) return "expired";
      return status === 0 || status === 429 || status >= 500 ? "retry" : "rejected";
    }
  }));

  const sent = results.filter((r) => r === "sent").length;
  const failed = results.length - sent;
  return sent === results.length
    ? json({ ok: true, sent, failed: 0 })
    : json({ ok: false, sent, failed }, 503);
}

async function processEvent(client: Client, eventId: number): Promise<Outcome> {
  const { data: event, error: eventError } = await client.from("push_events")
    .select("id,event_type,actor_id,customer_id,invoice_id,processed_at").eq("id", eventId).maybeSingle();
  if (eventError) throw eventError;
  if (!event) return { ok: true, info: "missing" };
  if (event.processed_at) return { ok: true, info: "duplicate" };
  const finish = async (info: string): Promise<Outcome> => { await markProcessed(client, event.id); return { ok: true, info }; };

  let title = "تنبيه من سجل الديون";
  let body = "لديك تحديث جديد في المتجر.";
  let claimedDay: string | null = null;
  const releaseClaim = async () => {
    if (claimedDay) {
      await client.from("push_credit_alerts").delete().eq("customer_id", event.customer_id).eq("alert_date", claimedDay);
      claimedDay = null;
    }
  };

  if (event.event_type === "invoice_created" || event.event_type === "invoice_voided") {
    // يصل الإشعار لكل المديرين المشتركين، سواء كان من سجّل الفاتورة بائعاً أو مديراً.
    let actorName = "أحد المستخدمين";
    if (event.actor_id) {
      const { data: actor, error } = await client.from("profiles").select("username,name").eq("id", event.actor_id).maybeSingle();
      if (error) throw error;
      actorName = actor?.name || actor?.username || actorName;
    }
    let kindLabel = "فاتورة";
    if (event.invoice_id) {
      const { data: inv, error } = await client.from("invoices").select("kind").eq("id", event.invoice_id).maybeSingle();
      if (error) throw error;
      if (inv?.kind === "disbursement") kindLabel = "فاتورة سداد";
    }
    title = "حركة جديدة في سجل الديون";
    body = event.event_type === "invoice_voided"
      ? `ألغى ${actorName} ${kindLabel}.`
      : `سجّل ${actorName} ${kindLabel} جديدة.`;
  } else if (event.event_type === "credit_check") {
    if (!event.customer_id) return finish("skipped");
    const { data: balance, error } = await client.from("customer_balances")
      .select("debt,credit_limit").eq("id", event.customer_id).maybeSingle();
    if (error) throw error;
    const debt = Number(balance?.debt ?? 0), limit = Number(balance?.credit_limit ?? 0);
    if (!(limit > 0) || debt < limit * 0.9) return finish("skipped");
    title = "تنبيه حد الائتمان";
    body = "اقترب رصيد أحد العملاء من حد الائتمان المحدد.";
  } else {
    return finish("skipped");
  }

  const subscriptions = await getAdminSubscriptions(client);
  if (!subscriptions.length) return finish("no-subscribers");

  if (event.event_type === "credit_check") {
    claimedDay = new Date().toISOString().slice(0, 10);
    const { error } = await client.from("push_credit_alerts").insert({ customer_id: event.customer_id, alert_date: claimedDay });
    if (error) {
      claimedDay = null;
      if (error.code === "23505") return finish("deduplicated");
      throw error;
    }
  }

  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "";
  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    await releaseClaim();
    throw new Error("VAPID configuration missing");
  }

  // نفس الوسم لكل حدث: إعادة الإرسال تستبدل الإشعار بدل أن تكرّره على الجهاز
  const payloadText = JSON.stringify({ title, body, tag: `mystore-${event.id}`, url: "./" });
  const results = await Promise.all(subscriptions.map(async (s): Promise<string> => {
    if (!allowedEndpoint(s.endpoint)) {
      await client.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      return "dropped";
    }
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payloadText, {
        TTL: 3600, urgency: "normal",
        vapidDetails: { subject: vapidSubject, publicKey: vapidPublicKey, privateKey: vapidPrivateKey },
      });
      return "sent";
    } catch (error) {
      const status = Number((error as { statusCode?: number })?.statusCode ?? 0);
      if (status === 404 || status === 410) {
        await client.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        return "gone";
      }
      console.warn("Push delivery failed", { eventId: event.id, status });
      // إعادة المحاولة فقط للأخطاء المؤقتة (شبكة، 429، 5xx)؛ غيرها يُرفض نهائياً
      return status === 0 || status === 429 || status >= 500 ? "retry" : "rejected";
    }
  }));

  if (results.includes("retry")) {
    await releaseClaim();
    return { ok: false, info: "transient" };
  }
  return finish(`sent:${results.filter((r) => r === "sent").length}`);
}

async function retryPending(client: Client) {
  const before = new Date(Date.now() - 2 * 60_000).toISOString();
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data, error } = await client.from("push_events").select("id")
    .is("processed_at", null).lt("created_at", before).gt("created_at", since).order("id").limit(20);
  if (error) throw error;
  let done = 0, failed = 0;
  for (const row of data ?? []) {
    try { (await processEvent(client, Number(row.id))).ok ? done++ : failed++; } catch { failed++; }
  }
  return json({ ok: true, done, failed });
}

async function processWebhook(payload: WebhookPayload, client: Client) {
  if (payload.action === "test_push") return await sendTestNotification(client);
  if (payload.action === "retry_pending") return await retryPending(client);
  if (payload.type !== "INSERT" || payload.schema !== "public" || payload.table !== "push_events") {
    return json({ error: "حدث غير مدعوم" }, 400);
  }
  const eventId = Number(payload.record?.id);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) return json({ error: "معرّف حدث غير صحيح" }, 400);
  const outcome = await processEvent(client, eventId);
  return outcome.ok ? json({ ok: true, info: outcome.info }) : json({ error: "تعذر تسليم الإشعار الآن" }, 503);
}

async function publicKeyForAdmin(req: Request, client: Client) {
  if (!serviceUrl || !anonKey) return json({ error: "إعدادات المصادقة غير مكتملة" }, 500);
  const match = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!match) return json({ error: "غير مصرح" }, 401);
  let body: { action?: string };
  try { body = await req.json(); } catch { return json({ error: "طلب غير صحيح" }, 400); }
  if (body.action !== "public_key") return json({ error: "عملية غير معروفة" }, 400);
  const userClient = createClient<any>(serviceUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user }, error: userError } = await userClient.auth.getUser(match[1]);
  if (userError || !user) return json({ error: "جلسة غير صالحة" }, 401);
  const { data: profile, error: profileError } = await client.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (profileError || profile?.role !== "admin") return json({ error: "المدير فقط" }, 403);
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
  if (!publicKey) return json({ error: "لم تُضبط مفاتيح Web Push بعد" }, 503);
  return json({ publicKey });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "طريقة غير مسموحة" }, 405);
  if (!adminClient) return json({ error: "إعدادات Supabase غير مكتملة" }, 500);

  const webhookHeader = req.headers.get("x-push-webhook-secret");
  if (webhookHeader !== null) {
    const expected = Deno.env.get("PUSH_WEBHOOK_SECRET") ?? "";
    if (expected.length < 32 || !(await safeEqual(webhookHeader, expected))) return json({ error: "غير مصرح" }, 401);
    try {
      return await processWebhook(await req.json() as WebhookPayload, adminClient);
    } catch (error) {
      console.error("Push webhook processing failed", error instanceof Error ? error.name : "unknown");
      return json({ error: "تعذر معالجة حدث الإشعار" }, 503);
    }
  }
  try { return await publicKeyForAdmin(req, adminClient); }
  catch { return json({ error: "تعذر تجهيز الإشعارات" }, 500); }
});
