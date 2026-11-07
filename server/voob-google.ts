// VOOB — вход через Google (Supabase Edge Function voob-google) · v1.0
// Аккаунт VOOB = Telegram ID. Google только привязывается к нему и открывает тот же профиль.
// Таблицы: google_links(google_sub pk, tg_id unique, email), sessions(token_hash, tg_id, device), users.
import { createClient } from "npm:@supabase/supabase-js@2";

function serverKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const single = Deno.env.get("SUPABASE_SECRET_KEY");
  if (single) return single;
  try {
    const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    return all.default ?? Object.values(all)[0] ?? "";
  } catch { return ""; }
}
const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", serverKey(), { auth: { persistSession: false } });
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "641775711992-ra7vdtqtp74egslhfd0j2cqj12hqgn6c.apps.googleusercontent.com";

const enc = new TextEncoder();
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
const fail = (msg: string, status = 400) => json({ error: msg }, status);
const noSession = () => fail("Сессия недействительна — войди заново", 401);
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createSession(tgId: number, device: string) {
  const token = randomToken();
  const { error } = await db.from("sessions").insert({ token_hash: await sha256(token), tg_id: tgId, device });
  if (error) throw error;
  return token;
}
async function sessionUser(token: unknown): Promise<number | null> {
  if (typeof token !== "string" || token.length < 20) return null;
  const h = await sha256(token);
  const { data } = await db.from("sessions").select("tg_id").eq("token_hash", h).maybeSingle();
  if (!data) return null;
  db.from("sessions").update({ last_seen: new Date().toISOString() }).eq("token_hash", h).then(() => {});
  return data.tg_id as number;
}
async function userInfo(tgId: number) {
  const { data } = await db.from("users").select("tg_id, first_name, username, handle").eq("tg_id", tgId).maybeSingle();
  return data ?? { tg_id: tgId };
}

async function googleVerify(idToken: unknown): Promise<{ sub: string; email: string } | null> {
  if (typeof idToken !== "string" || idToken.length < 100 || idToken.length > 4096) return null;
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken)).catch(() => null);
  if (!r || !r.ok) return null;
  const t = await r.json().catch(() => null);
  if (!t || t.aud !== GOOGLE_CLIENT_ID || !t.sub) return null;
  if (t.iss !== "accounts.google.com" && t.iss !== "https://accounts.google.com") return null;
  if (Number(t.exp) * 1000 < Date.now()) return null;
  const ok = t.email_verified === true || t.email_verified === "true";
  return { sub: String(t.sub), email: ok ? String(t.email ?? "") : "" };
}

async function routeLogin(body: any) {
  const g = await googleVerify(body?.credential);
  if (!g) return fail("Не удалось подтвердить вход через Google", 401);
  const { data } = await db.from("google_links").select("tg_id").eq("google_sub", g.sub).maybeSingle();
  if (!data) return json({ status: "unlinked" });
  const token = await createSession(data.tg_id as number, "web");
  return json({ status: "ok", token, user: await userInfo(data.tg_id as number) });
}
async function routeLink(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const g = await googleVerify(body?.credential);
  if (!g) return fail("Не удалось подтвердить вход через Google", 401);
  const { data: ex } = await db.from("google_links").select("tg_id").eq("google_sub", g.sub).maybeSingle();
  if (ex && ex.tg_id !== me) return fail("Этот Google-аккаунт уже привязан к другому профилю VOOB", 409);
  await db.from("google_links").delete().eq("tg_id", me);   // один Google на аккаунт: новая привязка заменяет старую
  const { error } = await db.from("google_links").insert({ google_sub: g.sub, tg_id: me, email: g.email || null });
  if (error) return fail("Не удалось привязать Google", 500);
  return json({ status: "ok", email: g.email });
}
async function routeStatus(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const { data } = await db.from("google_links").select("email").eq("tg_id", me).maybeSingle();
  return json({ linked: !!data, email: data?.email ?? "" });
}
async function routeUnlink(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  await db.from("google_links").delete().eq("tg_id", me);
  return json({ status: "ok" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const route = (new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop() ?? "").toLowerCase();
  if (req.method !== "POST") return json({ app: "VOOB google", ok: true });
  try {
    const body = await req.json().catch(() => ({}));
    switch (route) {
      case "login": return await routeLogin(body);
      case "link": return await routeLink(body);
      case "status": return await routeStatus(body);
      case "unlink": return await routeUnlink(body);
    }
    return fail("Неизвестный маршрут " + route, 404);
  } catch (e) {
    console.error(e);
    return fail("Внутренняя ошибка сервера", 500);
  }
});
