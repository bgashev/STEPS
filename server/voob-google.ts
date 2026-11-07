// VOOB — вход через Google (Supabase Edge Function voob-google) · v1.1 (access_token, отвязка по коду из бота)
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

// Клиент присылает access_token окна выбора аккаунта Google; проверяем его у Google и сверяем, что он выдан именно нашему приложению
async function googleVerify(tok: unknown): Promise<{ sub: string; email: string } | null> {
  if (typeof tok !== "string" || tok.length < 20 || tok.length > 4096) return null;
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(tok)).catch(() => null);
  if (!r || !r.ok) return null;
  const t = await r.json().catch(() => null);
  if (!t || !t.sub || (t.aud !== GOOGLE_CLIENT_ID && t.azp !== GOOGLE_CLIENT_ID)) return null;
  if (Number(t.expires_in) <= 0) return null;
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
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const ACT = "google_unlink", ACT_TTL_MIN = 10, ACT_TRIES = 5;
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function tgSend(chat: number, text: string) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, parse_mode: "HTML", text }),
  }).catch(() => null);
  return !!(r && (await r.json().catch(() => ({}))).ok);
}
// Отвязка Google подтверждается 4-значным кодом, который приходит в Telegram-бота
async function routeUnlinkStart(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const { data: l } = await db.from("google_links").select("email").eq("tg_id", me).maybeSingle();
  if (!l) return fail("Google не привязан", 409);
  const { data: old } = await db.from("action_codes").select("created_at").eq("tg_id", me).eq("action", ACT).maybeSingle();
  if (old && Date.now() - new Date(old.created_at).getTime() < 60000) return json({ status: "soon", ttl: ACT_TTL_MIN * 60 });
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");
  await db.from("action_codes").upsert({ tg_id: me, action: ACT, code_hash: await sha256(`act:${ACT}:${me}:${code}`), tries: 0,
    created_at: new Date().toISOString() }, { onConflict: "tg_id,action" });
  const sent = await tgSend(me, `🔓 Код для отвязки Google от VOOB: <b>${code}</b>\n\nПосле этого вход через Google перестанет открывать твой аккаунт. Вход через Telegram продолжит работать.\n\nДействует ${ACT_TTL_MIN} минут. Если это не ты — никому не говори код и просто игнорируй сообщение.`);
  return json({ status: sent ? "sent" : "undelivered", ttl: ACT_TTL_MIN * 60 });
}
async function routeUnlinkVerify(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const code = String(body?.code ?? "").trim();
  const { data: r } = await db.from("action_codes").select("code_hash, tries, created_at").eq("tg_id", me).eq("action", ACT).maybeSingle();
  if (!r || Date.now() - new Date(r.created_at).getTime() > ACT_TTL_MIN * 60000) return json({ status: "expired" });
  if (r.tries >= ACT_TRIES) return json({ status: "locked" });
  if (!/^\d{4}$/.test(code) || !safeEqual(await sha256(`act:${ACT}:${me}:${code}`), r.code_hash)) {
    await db.from("action_codes").update({ tries: r.tries + 1 }).eq("tg_id", me).eq("action", ACT);
    return json({ status: r.tries + 1 >= ACT_TRIES ? "locked" : "wrong", left: ACT_TRIES - r.tries - 1 });
  }
  await db.from("action_codes").delete().eq("tg_id", me).eq("action", ACT);
  await db.from("google_links").delete().eq("tg_id", me);
  tgSend(me, "✅ Google отвязан от аккаунта VOOB. Вход в WEB — через Telegram.");
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
      case "unlink-start": return await routeUnlinkStart(body);
      case "unlink-verify": return await routeUnlinkVerify(body);
    }
    return fail("Неизвестный маршрут " + route, 404);
  } catch (e) {
    console.error(e);
    return fail("Внутренняя ошибка сервера", 500);
  }
});
