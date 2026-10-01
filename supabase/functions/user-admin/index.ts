import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const usernamePattern = /^[\p{L}\p{N}_-]{2,40}$/u;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "طريقة غير مسموحة" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "غير مصرح" }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: "جلسة غير صالحة" }, 401);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { data: actor, error: actorError } = await adminClient
    .from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (actorError || actor?.role !== "admin") return json({ error: "المدير فقط" }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "بيانات غير صحيحة" }, 400); }
  const action = body?.action;

  if (action === "list") {
    const { data, error } = await adminClient
      .from("profiles").select("id,username,name,role").order("name").limit(200);
    if (error) return json({ error: error.message }, 400);
    return json({ users: data ?? [] });
  }

  if (!["create", "update"].includes(action)) return json({ error: "عملية غير معروفة" }, 400);
  const username = String(body.username ?? "").trim();
  const name = String(body.name ?? "").trim();
  const role = body.role === "admin" ? "admin" : "seller";
  const password = String(body.password ?? "");
  if (!usernamePattern.test(username)) return json({ error: "اسم المستخدم: حرفان على الأقل، وبدون مسافات" }, 400);
  if (!name) return json({ error: "أدخل الاسم" }, 400);
  if (action === "create" && password.length < 6) return json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" }, 400);

  if (action === "create") {
    const internalEmail = `u_${crypto.randomUUID()}@users.mystore.internal`;
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email: internalEmail,
      password,
      email_confirm: true,
    });
    if (createError || !created.user) return json({ error: createError?.message ?? "تعذر إنشاء المستخدم" }, 400);
    const { error: profileError } = await adminClient.from("profiles").upsert({
      id: created.user.id, username, name, role,
    });
    if (profileError) {
      await adminClient.auth.admin.deleteUser(created.user.id);
      return json({ error: profileError.message }, 400);
    }
    return json({ ok: true });
  }

  const id = String(body.id ?? "");
  if (!id) return json({ error: "معرّف المستخدم مطلوب" }, 400);
  const { data: target, error: targetError } = await adminClient
    .from("profiles").select("id,role").eq("id", id).maybeSingle();
  if (targetError || !target) return json({ error: "المستخدم غير موجود" }, 404);
  if (target.id === user.id && role !== "admin") return json({ error: "لا يمكنك إلغاء دورك كمدير" }, 400);
  if (target.role === "admin" && role !== "admin") {
    const { count } = await adminClient.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin");
    if ((count ?? 0) <= 1) return json({ error: "يجب إبقاء مدير واحد على الأقل" }, 400);
  }
  const { error: profileError } = await adminClient.from("profiles").update({ username, name, role }).eq("id", id);
  if (profileError) return json({ error: profileError.message }, 400);
  if (password) {
    if (password.length < 6) return json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" }, 400);
    const { error: passwordError } = await adminClient.auth.admin.updateUserById(id, { password });
    if (passwordError) return json({ error: passwordError.message }, 400);
  }
  return json({ ok: true });
});
