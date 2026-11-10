// VOOB — вход по @username и паролю (Supabase Edge Function voob-pass) · v1
// Аккаунт VOOB = Telegram ID. Пароль — дополнительный способ входа в WEB: логин = @username из VOOB.
// Добавление/смена/удаление пароля подтверждаются 4-значным кодом, который приходит в бота (как отвязка Google).
// Таблицы: user_passwords(tg_id pk, pwd_hash, pwd_salt, updated_at), pass_attempts(k, at), action_codes, sessions, users.
import { createClient } from "npm:@supabase/supabase-js@2";

function serverKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); if (legacy) return legacy;
  const single = Deno.env.get("SUPABASE_SECRET_KEY"); if (single) return single;
  try { const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return all.default ?? Object.values(all)[0] ?? ""; } catch { return ""; }
}
const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", serverKey(), { auth: { persistSession: false } });
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
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
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const PBKDF_ITER = 210000, PWD_MIN = 8, PWD_MAX = 128;
const LOGIN_FAILS = 5, IP_FAILS = 25, WINDOW_MIN = 15;
const ACT_SET = "pass_set", ACT_DEL = "pass_remove", ACT_TTL_MIN = 10, ACT_TRIES = 5;

async function derive(pwd: string, saltHex: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pwd), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF_ITER }, key, 256));
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
async function tgSend(chat: number, text: string) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, parse_mode: "HTML", text }),
  }).catch(() => null);
  return !!(r && (await r.json().catch(() => ({}))).ok);
}
async function fails(k: string) {
  const { count } = await db.from("pass_attempts").select("id", { count: "exact", head: true }).eq("k", k)
    .gte("at", new Date(Date.now() - WINDOW_MIN * 60000).toISOString());
  return count ?? 0;
}

// ---- вход: @username + пароль → та же WEB-сессия, что и после QR
async function routeLogin(req: Request, body: any) {
  const login = String(body?.login ?? "").trim().replace(/^@/, "").toLowerCase();
  const pwd = String(body?.password ?? "");
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "?";
  const kL = "h:" + login.slice(0, 40), kI = "i:" + (await sha256(ip)).slice(0, 24);
  if ((await fails(kL)) >= LOGIN_FAILS || (await fails(kI)) >= IP_FAILS) return json({ status: "locked" });
  let row: any = null;
  if (/^[a-z0-9_.]{3,20}$/.test(login)) {
    const { data: us } = await db.from("users").select("tg_id, blocked, handle").ilike("handle", login).limit(5);   // «_» в ilike — подстановка, поэтому точное совпадение проверяем сами
    const u = (us ?? []).find((x: any) => String(x.handle ?? "").toLowerCase() === login);
    if (u && !u.blocked) {
      const { data: p } = await db.from("user_passwords").select("pwd_hash, pwd_salt").eq("tg_id", u.tg_id).maybeSingle();
      if (p) row = { tg_id: u.tg_id as number, ...p };
    }
  }
  const salt = row?.pwd_salt ?? "00".repeat(16);
  const ok = pwd.length >= 1 && pwd.length <= PWD_MAX && safeEqual(await derive(pwd, salt), row?.pwd_hash ?? "x".repeat(64)) && !!row;
  if (!ok) {
    await db.from("pass_attempts").insert([{ k: kL }, { k: kI }]);
    db.from("pass_attempts").delete().lt("at", new Date(Date.now() - 24 * 3600000).toISOString()).then(() => {});
    return json({ status: "wrong" });
  }
  const token = await createSession(row.tg_id, "web");
  return json({ status: "ok", token, user: await userInfo(row.tg_id) });
}
async function routeStatus(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const [{ data: p }, { data: u }] = await Promise.all([
    db.from("user_passwords").select("updated_at").eq("tg_id", me).maybeSingle(),
    db.from("users").select("handle").eq("tg_id", me).maybeSingle(),
  ]);
  return json({ has_pwd: !!p, updated: p?.updated_at ?? null, handle: u?.handle ?? "" });
}

// ---- коды в бота
async function startCode(me: number, act: string, text: (c: string) => string) {
  const { data: old } = await db.from("action_codes").select("created_at").eq("tg_id", me).eq("action", act).maybeSingle();
  if (old && Date.now() - new Date(old.created_at).getTime() < 60000) return json({ status: "soon", ttl: ACT_TTL_MIN * 60 });
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");
  await db.from("action_codes").upsert({ tg_id: me, action: act, code_hash: await sha256(`act:${act}:${me}:${code}`), tries: 0,
    created_at: new Date().toISOString() }, { onConflict: "tg_id,action" });
  const sent = await tgSend(me, text(code));
  return json({ status: sent ? "sent" : "undelivered", ttl: ACT_TTL_MIN * 60 });
}
async function checkCode(me: number, act: string, codeIn: unknown): Promise<null | Response> {
  const code = String(codeIn ?? "").trim();
  const { data: r } = await db.from("action_codes").select("code_hash, tries, created_at").eq("tg_id", me).eq("action", act).maybeSingle();
  if (!r || Date.now() - new Date(r.created_at).getTime() > ACT_TTL_MIN * 60000) return json({ status: "expired" });
  if (r.tries >= ACT_TRIES) return json({ status: "locked" });
  if (!/^\d{4}$/.test(code) || !safeEqual(await sha256(`act:${act}:${me}:${code}`), r.code_hash)) {
    await db.from("action_codes").update({ tries: r.tries + 1 }).eq("tg_id", me).eq("action", act);
    return json({ status: r.tries + 1 >= ACT_TRIES ? "locked" : "wrong", left: ACT_TRIES - r.tries - 1 });
  }
  await db.from("action_codes").delete().eq("tg_id", me).eq("action", act);
  return null;
}
async function routeSetStart(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const { data: u } = await db.from("users").select("handle, blocked").eq("tg_id", me).maybeSingle();
  if (!u?.handle) return fail("Сначала задай @username в профиле — он будет твоим логином", 409);
  const { data: p } = await db.from("user_passwords").select("tg_id").eq("tg_id", me).maybeSingle();
  return await startCode(me, ACT_SET, (c) => `🔑 Код для ${p ? "смены" : "добавления"} пароля VOOB: <b>${c}</b>\n\nПосле этого в WEB можно будет войти по логину @${u.handle} и паролю. Вход через Telegram продолжит работать.\n\nДействует ${ACT_TTL_MIN} минут. Если это не ты — никому не говори код и просто игнорируй сообщение.`);
}
async function routeSetVerify(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const pwd = String(body?.password ?? "");
  if (pwd.length < PWD_MIN) return fail(`Пароль слишком короткий: минимум ${PWD_MIN} символов`);
  if (pwd.length > PWD_MAX) return fail(`Пароль слишком длинный: максимум ${PWD_MAX} символов`);
  const { data: u } = await db.from("users").select("handle").eq("tg_id", me).maybeSingle();
  if (!u?.handle) return fail("Сначала задай @username в профиле", 409);
  if (pwd.toLowerCase() === u.handle.toLowerCase()) return fail("Пароль не должен совпадать с логином");
  const bad = await checkCode(me, ACT_SET, body?.code);
  if (bad) return bad;
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const { data: had } = await db.from("user_passwords").select("tg_id").eq("tg_id", me).maybeSingle();
  const { error } = await db.from("user_passwords").upsert({ tg_id: me, pwd_hash: await derive(pwd, salt), pwd_salt: salt, updated_at: new Date().toISOString() }, { onConflict: "tg_id" });
  if (error) return fail("Не удалось сохранить пароль", 500);
  tgSend(me, had ? "🔑 Пароль VOOB изменён." : `🔑 Пароль VOOB добавлен. Теперь в WEB можно войти по логину @${u.handle} и паролю.`);
  return json({ status: "ok", has_pwd: true });
}
async function routeDelStart(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const { data: p } = await db.from("user_passwords").select("tg_id").eq("tg_id", me).maybeSingle();
  if (!p) return fail("Пароль не задан", 409);
  return await startCode(me, ACT_DEL, (c) => `🔓 Код для удаления пароля VOOB: <b>${c}</b>\n\nПосле этого вход по логину и паролю перестанет работать. Вход через Telegram продолжит работать.\n\nДействует ${ACT_TTL_MIN} минут. Если это не ты — никому не говори код и просто игнорируй сообщение.`);
}
async function routeDelVerify(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const bad = await checkCode(me, ACT_DEL, body?.code);
  if (bad) return bad;
  await db.from("user_passwords").delete().eq("tg_id", me);
  tgSend(me, "✅ Пароль VOOB удалён. Вход в WEB — через Telegram.");
  return json({ status: "ok", has_pwd: false });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const route = (new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop() ?? "").toLowerCase();
  if (req.method !== "POST") return json({ app: "VOOB pass", ok: true });
  try {
    const body = await req.json().catch(() => ({}));
    switch (route) {
      case "login": return await routeLogin(req, body);
      case "status": return await routeStatus(body);
      case "set-start": return await routeSetStart(body);
      case "set-verify": return await routeSetVerify(body);
      case "remove-start": return await routeDelStart(body);
      case "remove-verify": return await routeDelVerify(body);
    }
    return fail("Неизвестный маршрут", 404);
  } catch (e) {
    console.error(e);
    return fail("Внутренняя ошибка сервера", 500);
  }
});
