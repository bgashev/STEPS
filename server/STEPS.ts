// VOOB (ранее STEPS) — серверная функция синхронизации (Supabase Edge Function) · v1.453 (заморозка PRO, отложенное удаление аккаунта)
import { createClient } from "npm:@supabase/supabase-js@2";

const APP_URL = "https://app.voob.kz/";
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const ADMIN_TG_ID = Number(Deno.env.get("ADMIN_TG_ID") ?? 0) || 0;
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
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
const SB_KEY = serverKey();
const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const CODE_TTL_MIN = 10;
const INITDATA_MAX_AGE = 172800;
const MAX_ROWS = 3000;
const MAX_FRIENDS = 100;
const POKE_HOURS = 12;
const GIFT_ENERGY = 3;        // подарков в месяц на одного отправителя (без PRO)
const GIFT_ENERGY_PRO = 5;    // М1: с PRO — 5 в месяц, не безлимит
const GIFT_XP = 100;          // за первый подарок каждого вида
// v1.462: премиум-подарки — дарить может только PRO, получатель берёт +200 вместо +100
const GIFT_XP_PRO = 200;
const PRO_GIFTS = new Set(["pr_diamond", "pr_goldbar", "pr_champagne", "pr_watch", "pr_perfume", "pr_orb", "pr_ring", "pr_plasma", "pr_hourglass", "pr_belt"]);
const giftXp = (kind: string) => (PRO_GIFTS.has(kind) ? GIFT_XP_PRO : GIFT_XP);
const FEEDBACK_PER_DAY = 5;
// Виды подарков лежат в таблице gift_types (kind → эмодзи, название): новые добавляются без передеплоя
let _gt: Record<string, [string, string]> = {};
let _gtAt = 0;
async function giftTypes(): Promise<Record<string, [string, string]>> {
  if (Date.now() - _gtAt < 60000 && Object.keys(_gt).length) return _gt;
  const { data } = await db.from("gift_types").select("kind, emoji, title").order("sort");
  if (data?.length) { _gt = Object.fromEntries(data.map((r: any) => [r.kind, [r.emoji, r.title]])); _gtAt = Date.now(); }
  return _gt;
}
// анти-чит: одинаковые правила с клиентами
const AC = { minMin: 1, maxMin: 240, minSpeed: 0.5, maxSpeed: 20, maxIncline: 15, dayMin: 300, dayCount: 6, lateDays: 3 };
// v1.420: силовые — подходы × повторы (у планки подходы × секунды, у гантелей ещё вес); те же правила в клиентах
const STR: Record<string, { per: "reps" | "secs"; max: number; xp: number }> = {
  pushup: { per: "reps", max: 200, xp: 0.5 }, squat: { per: "reps", max: 300, xp: 0.35 },
  pullup: { per: "reps", max: 100, xp: 1.2 }, plank: { per: "secs", max: 900, xp: 1 / 6 },
  dumbbell: { per: "reps", max: 100, xp: 0.3 }, burpee: { per: "reps", max: 100, xp: 1.0 },
  barbell: { per: "reps", max: 100, xp: 0.35 }, abs: { per: "reps", max: 300, xp: 0.3 },   // v1.451
};
// v1.421: по времени — велосипед (скорость по желанию, до 45 км/ч) и растяжка/йога (без скорости)
const TIME: Record<string, { xp: number; maxSpeed: number }> = { bike: { xp: 0.9, maxSpeed: 45 }, yoga: { xp: 0.6, maxSpeed: 0 },
  jumprope: { xp: 1.1, maxSpeed: 0 }, stepper: { xp: 0.8, maxSpeed: 0 }, swim: { xp: 1.0, maxSpeed: 0 } };   // v1.451
const KG_ACTS = new Set(["dumbbell", "barbell"]);   // силовые с весом
// v1.421: подходы могут быть разными — список sl [12, 10, 8]; иначе sets × reps
function strTotal(w: any) {
  const st = STR[w.act];
  if (!st) return 0;
  if (Array.isArray(w.sl) && w.sl.length) return w.sl.reduce((a: number, x: any) => a + (Number(x) || 0), 0);
  return (Number(w.sets) || 0) * (Number(st.per === "reps" ? w.reps : w.secs) || 0);
}
const MAX_SETS = 20;
const MAX_KG = 150;
const RESERVED = new Set(["admin", "voob", "steps", "support", "bgashev_admin", "god", "moderator", "system"]);

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

const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function hmac(key: string | Uint8Array<ArrayBuffer>, msg: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey(
    "raw", typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomCode(len = 12): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(len));
  return [...b].map((x) => A[x % A.length]).join("");
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const webhookSecret = async () => (await sha256("steps-webhook:" + BOT_TOKEN)).slice(0, 48);

async function tg(method: string, payload: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  return await r.json();
}

type TgUser = { id: number; first_name?: string; username?: string };

async function upsertUser(u: TgUser) {
  await db.from("users").upsert({
    tg_id: u.id, first_name: u.first_name ?? null, username: u.username ?? null,
    last_seen: new Date().toISOString(),
  }, { onConflict: "tg_id" });
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

async function verifyInitData(initData: string): Promise<TgUser | null> {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac("WebAppData", BOT_TOKEN);
  if (!safeEqual(hex(await hmac(secret, check)), hash)) return null;
  const authDate = Number(p.get("auth_date") ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > INITDATA_MAX_AGE) return null;
  try { const u = JSON.parse(p.get("user") ?? "null"); return u && u.id ? u : null; } catch { return null; }
}

const DAY = 86400000;
const dnum = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY) : null;
};
const fmtCode = (c: string) => c.slice(0, 4) + "-" + c.slice(4);
const normCode = (c: unknown) => String(c ?? "").toUpperCase().replace(/STEPS/g, "").replace(/[^A-Z0-9]/g, "");
const openBtnMk = () => ({ inline_keyboard: [[{ text: "Открыть VOOB", web_app: { url: APP_URL } }]] });
const HANDLE_RE = /^[A-Za-z][A-Za-z0-9_]{2,19}$/;
const normHandle = (h: unknown) => String(h ?? "").trim().replace(/^@+/, "");

async function myCode(tgId: number): Promise<string> {
  const { data } = await db.from("users").select("friend_code").eq("tg_id", tgId).maybeSingle();
  if (data?.friend_code) return data.friend_code;
  for (let i = 0; i < 6; i++) {
    const code = randomCode(8);
    const { error } = await db.from("users").update({ friend_code: code }).eq("tg_id", tgId);
    if (!error) return code;
  }
  throw new Error("friend_code");
}
let _botName = "";
async function botName() {
  if (_botName) return _botName;
  const me = await tg("getMe", {});
  _botName = me?.result?.username ?? "voobkz_bot";
  return _botName;
}
const shareLink = async (handle: string) => `https://t.me/${await botName()}/VOOB?startapp=u_${handle}`;
const displayName = (u: any) => u?.first_name || (u?.handle ? "@" + u.handle : u?.username ? "@" + u.username : "Друг");

async function friendIds(id: number): Promise<number[]> {
  const { data } = await db.from("friends").select("b").eq("a", id);
  return (data ?? []).map((x: any) => x.b);
}
async function areFriends(a: number, b: number) {
  const { data } = await db.from("friends").select("a").eq("a", a).eq("b", b).maybeSingle();
  return !!data;
}
async function friendCount(id: number) {
  const { count } = await db.from("friends").select("a", { count: "exact", head: true }).eq("a", id);
  return count ?? 0;
}
async function makeFriends(a: number, b: number) {
  const { error } = await db.from("friends").upsert([{ a, b }, { a: b, b: a }], { onConflict: "a,b" });
  if (error) throw error;
  await db.from("friend_requests").delete().or(`and(from_id.eq.${a},to_id.eq.${b}),and(from_id.eq.${b},to_id.eq.${a})`);
}
function notify(to: number, text: string) {
  tg("sendMessage", { chat_id: to, text, reply_markup: openBtnMk() }).catch(() => {});
}

async function linkFriends(me: number, code: string) {
  const c = normCode(code);
  if (c.length < 6) return { status: "nocode" };
  const { data: owner } = await db.from("users").select("tg_id, first_name, username, handle").eq("friend_code", c).maybeSingle();
  if (!owner) return { status: "nocode" };
  if (owner.tg_id === me) return { status: "self", owner };
  if (await areFriends(me, owner.tg_id)) return { status: "already", owner };
  if ((await friendCount(me)) >= MAX_FRIENDS || (await friendCount(owner.tg_id)) >= MAX_FRIENDS) return { status: "limit", owner };
  await makeFriends(me, owner.tg_id);
  notify(owner.tg_id, `🎉 ${displayName(await userInfo(me))} теперь твой друг в VOOB!\n\nСмотри успехи друг друга в разделе «Друзья».`);
  return { status: "ok", owner };
}

/* ---------- PRO: подписка за Telegram Stars ---------- */
async function proPlans(onlyActive = true) {
  let q = db.from("pro_plans").select("plan, title, stars, days, first_bonus_days, active").order("sort");
  if (onlyActive) q = q.eq("active", true);
  const { data } = await q;
  return data ?? [];
}
/* ---------- М6: заморозка PRO ----------
   Пауза = until сдвигается на «сейчас», остаток хранится в frozen_left_ms.
   Так остальные функции (значки, лента, промокоды) сами считают человека не-PRO. */
const freezeDaysFor = (plan: string | null) => plan === "year" ? 30 : plan === "month" ? 7 : 0;
const SUB_COLS = "until, plan, bonus_used, frozen_at, frozen_until, frozen_left_ms, freeze_used_at";
async function doUnfreeze(tgId: number, row: any, auto: boolean) {
  const base = Math.max(row.until ? new Date(row.until).getTime() : 0, Date.now());
  const until = new Date(base + Math.max(0, Number(row.frozen_left_ms ?? 0))).toISOString();
  const upd = { until, frozen_at: null, frozen_until: null, frozen_left_ms: null, updated_at: new Date().toISOString() };
  await db.from("pro_subs").update(upd).eq("tg_id", tgId).not("frozen_at", "is", null);
  if (auto) tg("sendMessage", { chat_id: tgId, parse_mode: "HTML", reply_markup: openBtnMk(),
    text: `☀️ Заморозка закончилась — VOOB PRO снова активен до <b>${fmtRu(until)}</b>. С возвращением!` }).catch(() => {});
  return { ...row, ...upd };
}
async function doFreeze(tgId: number, row: any) {
  const now = Date.now();
  const left = Math.max(0, new Date(row.until).getTime() - now);
  const to = new Date(now + freezeDaysFor(row.plan) * DAY).toISOString();
  await db.from("pro_subs").update({ until: new Date(now).toISOString(), frozen_at: new Date(now).toISOString(), frozen_until: to,
    frozen_left_ms: left, freeze_used_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() })
    .eq("tg_id", tgId).is("frozen_at", null);
  return to;
}
async function freezeUsed(tgId: number, usedAt: string | null) {
  if (!usedAt) return false;
  const { count } = await db.from("pro_payments").select("id", { count: "exact", head: true })
    .eq("tg_id", tgId).gt("created_at", usedAt).is("refunded_at", null);
  return !count;                                  // новая оплата открывает заморозку заново
}
const DELETE_GRACE_DAYS = 7;
async function isLocked(tgId: number) {            // заморозка PRO или удаление аккаунта в ожидании — только просмотр
  const [{ data: s }, { data: u }] = await Promise.all([db.from("pro_subs").select("frozen_at").eq("tg_id", tgId).maybeSingle(),
    db.from("users").select("delete_at").eq("tg_id", tgId).maybeSingle()]);
  return !!s?.frozen_at || !!u?.delete_at;
}
async function deactivatedSet(ids: number[]) {
  if (!ids.length) return new Set<number>();
  const { data } = await db.from("users").select("tg_id").in("tg_id", ids).not("delete_at", "is", null);
  return new Set<number>((data ?? []).map((x: any) => x.tg_id));
}
async function purgeDue() {                        // отложенное удаление: срок вышел — стираем окончательно
  const { data } = await db.from("users").select("tg_id").lt("delete_at", new Date().toISOString()).limit(20);
  for (const u of data ?? []) {
    const { error } = await db.rpc("delete_account", { p_tg: u.tg_id });
    if (error) { console.error(error); continue; }
    tg("sendMessage", { chat_id: u.tg_id, text: "Аккаунт VOOB удалён окончательно. Если захочешь вернуться — просто открой приложение, начнёшь с чистого листа. Спасибо, что был с нами 💛" }).catch(() => {});
  }
}
async function isFrozen(tgId: number) {
  const { data } = await db.from("pro_subs").select("frozen_at").eq("tg_id", tgId).maybeSingle();
  return !!data?.frozen_at;
}
async function proStatus(tgId: number) {
  let { data } = await db.from("pro_subs").select(SUB_COLS).eq("tg_id", tgId).maybeSingle();
  if (data?.frozen_at && data.frozen_until && new Date(data.frozen_until).getTime() <= Date.now()) data = await doUnfreeze(tgId, data, true);
  const frozen = !!data?.frozen_at;
  const until = data?.until ? new Date(data.until) : null;
  const active = !frozen && !!until && until.getTime() > Date.now();
  const plans = (await proPlans()).map((p: any) => ({ plan: p.plan, title: p.title, stars: p.stars, days: p.days,
    bonus_days: data?.bonus_used ? 0 : p.first_bonus_days }));
  const fd = freezeDaysFor(data?.plan ?? null);
  const canFreeze = active && fd > 0 && !(await freezeUsed(tgId, data?.freeze_used_at ?? null));
  const { data: du } = await db.from("users").select("delete_at").eq("tg_id", tgId).maybeSingle();
  const leftMs = frozen ? Number(data.frozen_left_ms ?? 0) : active ? until!.getTime() - Date.now() : 0;
  return { active, frozen, until: until ? until.toISOString() : null, plan: data?.plan ?? null,
    days_left: Math.ceil(leftMs / DAY), plans, del_at: du?.delete_at ?? null,
    frozen_until: frozen ? data.frozen_until : null, freeze_days: fd, can_freeze: canFreeze,
    freeze_used: !!data?.freeze_used_at && !canFreeze && !frozen && fd > 0 };
}
const fmtRu = (iso: string) => { const d = new Date(iso); return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`; };

async function routeProStatus(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  return json(await proStatus(me));
}

async function routeProInvoice(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const plan = String(body?.plan ?? "");
  const p = (await proPlans()).find((x: any) => x.plan === plan);
  if (!p) return fail("Неизвестный тариф");
  if (await isLocked(me)) return fail("Оплата недоступна, пока подписка заморожена или аккаунт ждёт удаления", 423);
  const to = Number(body?.for ?? 0);
  if (to) {                                                  // v1.429: PRO в подарок другу
    if (to === me || !(await areFriends(me, to))) return fail("Дарить можно только друзьям", 403);
    const fu = await userInfo(to) as any;
    const r = await tg("createInvoiceLink", {
      title: `PRO в подарок · ${p.days} дн.`.slice(0, 32),
      description: `VOOB PRO для ${displayName(fu)} на ${p.days} дн. Друг получит подарок «VOOB PRO» и все возможности подписки.`.slice(0, 255),
      payload: `pro:${plan}:${me}:${to}`, provider_token: "", currency: "XTR", prices: [{ label: p.title, amount: p.stars }],
    });
    if (!r?.ok) return fail("Не удалось создать счёт: " + (r?.description ?? "Telegram"), 502);
    return json({ link: r.result, plan, stars: p.stars, days: p.days, for: to });
  }
  const st = await proStatus(me);
  const bonus = st.plans.find((x: any) => x.plan === plan)?.bonus_days ?? 0;
  const desc = `PRO на ${p.days} дн.` + (bonus ? ` + ${bonus} дн. в подарок за первую подписку` : "") +
    ". Расширенная статистика, рамки, фоны, значки и другое.";
  const r = await tg("createInvoiceLink", {
    title: p.title, description: desc.slice(0, 255), payload: `pro:${plan}:${me}`,
    provider_token: "", currency: "XTR", prices: [{ label: p.title, amount: p.stars }],
  });
  if (!r?.ok) return fail("Не удалось создать счёт: " + (r?.description ?? "Telegram"), 502);
  return json({ link: r.result, plan, stars: p.stars, days: p.days, bonus_days: bonus });
}

function parseProPayload(s: string) {
  const m = /^pro:([a-z]+):(\d+)(?::(\d+))?$/.exec(s || "");
  return m ? { plan: m[1], tg: Number(m[2]), to: m[3] ? Number(m[3]) : 0 } : null;
}
async function onPreCheckout(q: any) {
  const pl = parseProPayload(q.invoice_payload);
  const p = pl ? (await proPlans()).find((x: any) => x.plan === pl.plan) : null;
  const ok = !!(pl && p && pl.tg === q.from?.id && q.currency === "XTR" && q.total_amount === p.stars)
    && (!pl!.to || await areFriends(pl!.tg, pl!.to))
    && !(await isFrozen(pl!.tg)) && !(pl!.to && await isFrozen(pl!.to));
  await tg("answerPreCheckoutQuery", ok ? { pre_checkout_query_id: q.id, ok: true }
    : { pre_checkout_query_id: q.id, ok: false, error_message: "Счёт устарел — открой оплату в VOOB ещё раз." });
}
async function onPaid(msg: any) {
  const sp = msg.successful_payment;
  const pl = parseProPayload(sp.invoice_payload);
  if (!pl || sp.currency !== "XTR" || pl.tg !== msg.from.id) {
    if (ADMIN_TG_ID) tg("sendMessage", { chat_id: ADMIN_TG_ID, text: `⚠️ Странный платёж: ${JSON.stringify(sp).slice(0, 900)}` }).catch(() => {});
    return;
  }
  await upsertUser(msg.from);
  if (pl.to) {                                               // v1.429: PRO в подарок другу
    const { data: gd, error: ge } = await db.rpc("pro_apply_gift", { p_to: pl.to, p_from: msg.from.id, p_plan: pl.plan,
      p_charge: sp.telegram_payment_charge_id, p_stars: sp.total_amount });
    if (ge) {
      console.error(ge);
      if (ADMIN_TG_ID) tg("sendMessage", { chat_id: ADMIN_TG_ID, text: `❌ PRO-подарок не записан (${msg.from.id} → ${pl.to}): ${ge.message}\ncharge: ${sp.telegram_payment_charge_id}` }).catch(() => {});
      await tg("sendMessage", { chat_id: msg.chat.id, text: "Оплата прошла, но подарок не успел дойти. Напиши /paysupport — разберёмся." });
      return;
    }
    const gr = Array.isArray(gd) ? gd[0] : gd;
    if (gr?.dup) return;
    const fu = await userInfo(pl.to) as any, me = await userInfo(msg.from.id) as any;
    await tg("sendMessage", { chat_id: msg.chat.id, text: `🎁 Готово! ${displayName(fu)} получит VOOB PRO до ${fmtRu(gr.until)}.\n\nСпасибо за щедрость 💛`, reply_markup: openBtnMk() });
    notify(pl.to, `👑 ${displayName(me)} дарит тебе VOOB PRO!\n\nПодписка действует до ${fmtRu(gr.until)}. Открой VOOB, чтобы забрать подарок.`);
    if (ADMIN_TG_ID) tg("sendMessage", { chat_id: ADMIN_TG_ID, text: `🎁 PRO-подарок · ${pl.plan} · ${sp.total_amount}⭐\n${displayName(me)} (id ${msg.from.id}) → ${displayName(fu)} (id ${pl.to})\ncharge: ${sp.telegram_payment_charge_id}` }).catch(() => {});
    return;
  }
  const { data, error } = await db.rpc("pro_apply_payment", { p_tg: msg.from.id, p_plan: pl.plan,
    p_charge: sp.telegram_payment_charge_id, p_stars: sp.total_amount });
  if (error) {
    console.error(error);
    if (ADMIN_TG_ID) tg("sendMessage", { chat_id: ADMIN_TG_ID, text: `❌ Оплата не записана (${msg.from.id}): ${error.message}\ncharge: ${sp.telegram_payment_charge_id}` }).catch(() => {});
    await tg("sendMessage", { chat_id: msg.chat.id, text: "Оплата прошла, но PRO не успел включиться. Напиши /paysupport — разберёмся." });
    return;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (row?.dup) return;
  const bonus = row?.bonus ? `\n🎁 Плюс ${row.bonus} дн. в подарок за первую подписку.` : "";
  await tg("sendMessage", { chat_id: msg.chat.id,
    text: `👑 VOOB PRO включён!\n\nДействует до ${fmtRu(row.until)}.${bonus}\n\nСпасибо, что поддерживаешь VOOB 💛`, reply_markup: openBtnMk() });
  if (ADMIN_TG_ID) {
    const u = await userInfo(msg.from.id) as any;
    tg("sendMessage", { chat_id: ADMIN_TG_ID, text: `💰 PRO · ${pl.plan} · ${sp.total_amount}⭐\n${displayName(u)}${u.handle ? " @" + u.handle : ""} (id ${msg.from.id})\nдо ${fmtRu(row.until)}\ncharge: ${sp.telegram_payment_charge_id}` }).catch(() => {});
  }
}
// /refund <charge_id> — только админ: возвращает звёзды и отнимает оплаченные дни
async function adminRefund(chatId: number, charge: string) {
  const { data: p } = await db.from("pro_payments").select("*").eq("charge_id", charge).maybeSingle();
  if (!p) return tg("sendMessage", { chat_id: chatId, text: "Платёж не найден" });
  if (p.refunded_at) return tg("sendMessage", { chat_id: chatId, text: "Уже возвращён" });
  const r = await tg("refundStarPayment", { user_id: p.payer_id ?? p.tg_id, telegram_payment_charge_id: charge });
  if (!r?.ok) return tg("sendMessage", { chat_id: chatId, text: "Telegram: " + (r?.description ?? "ошибка") });
  await db.from("pro_payments").update({ refunded_at: new Date().toISOString() }).eq("id", p.id);
  const { data: s } = await db.from("pro_subs").select("until").eq("tg_id", p.tg_id).maybeSingle();
  if (s?.until) {
    const nu = new Date(new Date(s.until).getTime() - (p.days + p.bonus_days) * DAY).toISOString();
    await db.from("pro_subs").update({ until: nu, updated_at: new Date().toISOString() }).eq("tg_id", p.tg_id);
  }
  notify(p.tg_id, `↩️ Возврат ${p.stars}⭐ за VOOB PRO оформлен.`);
  return tg("sendMessage", { chat_id: chatId, text: `Готово: возвращено ${p.stars}⭐, PRO уменьшен на ${p.days + p.bonus_days} дн.` });
}

/* ---------- XP, уровни, анти-чит ---------- */
function workoutXp(w: any) {
  const st = STR[w.act];
  if (st) {
    const total = strTotal(w);
    const kgf = KG_ACTS.has(w.act) ? 1 + Math.min(MAX_KG, Math.max(0, Number(w.kg) || 0)) / 20 : 1;
    return total > 0 ? Math.max(3, Math.min(150, Math.round(total * st.xp * kgf))) : 0;
  }
  const m = Math.max(0, Math.min(AC.maxMin, Number(w.minutes) || 0));
  if (m < 1) return 0;
  const tm = TIME[w.act];
  if (tm) return Math.max(3, Math.min(150, Math.round(m * tm.xp)));
  const sp = Math.max(1, Number(w.speed) || 5), inc = Math.max(0, Number(w.incline) || 0);
  const f = Math.pow(sp / 5, 0.8) * (1 + inc * 0.06);
  return Math.max(3, Math.min(150, Math.round(m * f)));
}
// v1.410: 1→2 стоит 120, каждый следующий дороже с ускорением
const levelNeed = (lvl: number) => 120 + 40 * (lvl - 1) + 2 * (lvl - 1) * (lvl - 1);
function levelOf(xp: number) {
  let lvl = 1, x = Math.max(0, Math.round(xp)), need = levelNeed(1);
  while (x >= need && lvl < 999) { x -= need; lvl++; need = levelNeed(lvl); }
  return { level: lvl, xp: Math.round(xp), into: x, need };
}
// Поля тренировки в допустимых пределах; created (сек) не позже чем через 3 дня после даты
function fieldsOk(w: any, today: number) {
  const d = dnum(w.date), m = Number(w.minutes), s = Number(w.speed), i = Number(w.incline ?? 0);
  if (d === null || d > today) return false;
  if (!(m >= AC.minMin && m <= AC.maxMin)) return false;
  const st = STR[w.act];
  if (st) {
    const n = Number(w.sets), v = Number(st.per === "reps" ? w.reps : w.secs), kg = Number(w.kg ?? 0);
    if (Array.isArray(w.sl)) {
      if (!(w.sl.length >= 1 && w.sl.length <= MAX_SETS && w.sl.length === n)) return false;
      if (!w.sl.every((x: any) => Number.isInteger(Number(x)) && Number(x) >= 1 && Number(x) <= st.max)) return false;
    } else if (!(Number.isInteger(n) && n >= 1 && n <= MAX_SETS && v >= 1 && v <= st.max)) return false;
    if (!(kg >= 0 && kg <= MAX_KG)) return false;
    const c0 = Number(w.created) || 0;
    return !(c0 > 0 && Math.floor(c0 * 1000 / DAY) - d > AC.lateDays);
  }
  const tm = TIME[w.act];
  if (tm) {
    if (!(s >= 0 && s <= tm.maxSpeed)) return false;
  } else {
    if (!(s >= AC.minSpeed && s <= AC.maxSpeed)) return false;
    if (!(i >= 0 && i <= AC.maxIncline)) return false;
  }
  const c = Number(w.created) || 0;
  if (c > 0 && Math.floor(c * 1000 / DAY) - d > AC.lateDays) return false;
  return true;
}
// Оставляет только честные тренировки: поля в пределах, не больше 6 и 300 минут в день
function honest(ws: any[], today: number) {
  const ok = ws.filter((w) => fieldsOk(w, today))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (Number(a.created) || 0) - (Number(b.created) || 0)));
  const per = new Map<string, { n: number; m: number }>();
  return ok.filter((w) => {
    const p = per.get(w.date) ?? { n: 0, m: 0 };
    const m = Number(w.minutes) || 0;
    if (p.n + 1 > AC.dayCount || p.m + m > AC.dayMin) return false;
    per.set(w.date, { n: p.n + 1, m: p.m + m });
    return true;
  });
}

function goalCycles(days: number[], perDay: Map<number, number>, today: number, cnt: number, len: number) {
  let S: number | null = null, count = 0, done = 0, run = 0, best = 0, last: number | null = null;
  for (const d of days) {
    if (d > today) break;
    if (S !== null && d > S + len - 1) { S = null; count = 0; run = 0; }
    if (S === null) { if (last !== null && d - last > len) run = 0; S = d; count = 0; }
    count += perDay.get(d) ?? 0;
    if (count >= cnt) { done++; run++; best = Math.max(best, run); last = d; S = null; count = 0; }
  }
  if (S !== null && today > S + len - 1) { S = null; count = 0; run = 0; }
  if (S === null && last !== null && today - last > len) run = 0;
  const doneToday = S === null && last === today;
  return {
    shown: doneToday ? cnt : count, target: cnt, days: len, done, best, run,
    done_today: doneToday, prev_ok: S === null && !doneToday && last !== null && today - last <= len,
    days_left: S !== null ? S + len - 1 - today + 1 : null,
  };
}

function cleanWorkouts(recs: any[], today: number) {
  const raw = recs.filter((r) => r.kind === "workout" && !r.deleted).map((r) => r.data || {});
  return honest(raw, today);
}
function statsOf(recs: any[], today: number, bonus = 0) {
  const ws = cleanWorkouts(recs, today);
  const st = recs.find((r) => r.kind === "meta" && r.id === "settings" && !r.deleted)?.data?.goal ?? {};
  const cnt = Math.max(1, Number(st.count) || 5), len = Math.max(1, Number(st.days) || 7);
  const per = new Map<number, number>();
  let wMin = 0, wN = 0, wKm = 0, last: any = null, xp = bonus;
  let mMin = 0, mN = 0, mKm = 0;
  const mKey = new Date(today * DAY).toISOString().slice(0, 7);
  for (const w of ws) {
    const d = dnum(w.date)!;
    per.set(d, (per.get(d) ?? 0) + 1);
    xp += workoutXp(w);
    if (d > today - 7) { wMin += Number(w.minutes) || 0; wN++; wKm += (Number(w.speed) || 0) * (Number(w.minutes) || 0) / 60; }
    if (String(w.date).startsWith(mKey)) { mMin += Number(w.minutes) || 0; mN++; mKm += (Number(w.speed) || 0) * (Number(w.minutes) || 0) / 60; }
    if (!last || w.date > last.date || (w.date === last.date && (w.created ?? 0) > (last.created ?? 0))) last = w;
  }
  const days7 = [];
  for (let d = today - 6; d <= today; d++) days7.push(ws.filter((w) => dnum(w.date) === d).reduce((a, w) => a + (Number(w.minutes) || 0), 0));
  return {
    week: { minutes: Math.round(wMin), workouts: wN, km: Math.round(wKm * 10) / 10, days: days7 },
    month: { key: mKey, minutes: Math.round(mMin), workouts: mN, km: Math.round(mKm * 10) / 10 },
    goal: goalCycles([...per.keys()].sort((a, b) => a - b), per, today, cnt, len),
    last: last ? { date: last.date, minutes: Number(last.minutes) || 0 } : null,
    total: ws.length,
    level: levelOf(xp),
  };
}
const FRAMES = new Set(["classic"]);
function frameOf(recs: any[]) {
  const f = recs.find((r) => r.kind === "meta" && r.id === "settings" && !r.deleted)?.data?.frame;
  return typeof f === "string" && FRAMES.has(f) ? f : null;
}
function detailsOf(recs: any[], today: number) {
  const ws = cleanWorkouts(recs, today);
  const km = (w: any) => (Number(w.speed) || 0) * (Number(w.minutes) || 0) / 60;
  const pick = (f: (w: any) => number) => ws.length ? ws.reduce((a, b) => (f(b) > f(a) ? b : a)) : null;
  const lo = pick((w) => Number(w.minutes) || 0), fa = pick(km), fs = pick((w) => Number(w.speed) || 0), st = pick((w) => Number(w.incline) || 0);
  const months: { m: string; minutes: number }[] = [];
  const t = new Date(today * DAY);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    months.push({ m: key, minutes: Math.round(ws.filter((w) => String(w.date).startsWith(key)).reduce((a, w) => a + (Number(w.minutes) || 0), 0)) });
  }
  const recent = ws.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.created ?? 0) - (a.created ?? 0))).slice(0, 5)
    .map((w) => ({ date: w.date, minutes: Number(w.minutes) || 0, speed: Number(w.speed) || 0, incline: Number(w.incline) || 0,
      act: w.act || "run", sets: Number(w.sets) || 0, reps: Number(w.reps) || 0, secs: Number(w.secs) || 0, kg: Number(w.kg) || 0,
      ...(typeof w.ex === "string" && w.ex.length < 24 ? { ex: w.ex } : {}),
      ...(Array.isArray(w.sl) ? { sl: w.sl.slice(0, MAX_SETS).map((x: any) => Number(x) || 0) } : {}) }));
  const daysSet = new Set(ws.map((w) => dnum(w.date)!));
  let bestRun = 0, cur = 0;
  for (const d of [...daysSet].sort((a, b) => a - b)) { cur = daysSet.has(d - 1) ? cur + 1 : 1; bestRun = Math.max(bestRun, cur); }
  const rec = (w: any, v: number) => (w ? { value: Math.round(v * 10) / 10, date: w.date } : null);
  const ach = recs.find((r) => r.kind === "meta" && r.id === "settings" && !r.deleted)?.data?.ach;
  return {
    ach: Array.isArray(ach) ? ach.filter((k: any) => typeof k === "string" && k.length < 24).slice(0, 60) : [],
    totals: { workouts: ws.length, minutes: Math.round(ws.reduce((a, w) => a + (Number(w.minutes) || 0), 0)),
      km: Math.round(ws.reduce((a, w) => a + km(w), 0) * 10) / 10, days: daysSet.size },
    records: { longest: rec(lo, Number(lo?.minutes) || 0), farthest: rec(fa, fa ? km(fa) : 0),
      fastest: rec(fs, Number(fs?.speed) || 0), steepest: rec(st, Number(st?.incline) || 0), best_days_row: bestRun },
    months, recent,
  };
}

async function loadRecs(ids: number[]): Promise<Map<number, any[]>> {
  const recs: any[] = [];
  if (!ids.length) return new Map();
  for (let from = 0; from < 100000; from += 1000) {
    const { data, error } = await db.from("records").select("tg_id, kind, id, data, deleted")
      .in("tg_id", ids).in("kind", ["workout", "meta"]).range(from, from + 999);
    if (error) throw error;
    recs.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const by = new Map<number, any[]>();
  for (const r of recs) { if (!by.has(r.tg_id)) by.set(r.tg_id, []); by.get(r.tg_id)!.push(r); }
  return by;
}
async function usersMap(ids: number[]) {
  const { data } = ids.length ? await db.from("users").select("tg_id, first_name, username, handle, private").in("tg_id", ids) : { data: [] };
  return new Map<number, any>((data ?? []).map((u: any) => [u.tg_id, u]));
}

/* ---------- подарки ---------- */
// по каждому получателю: всего полученных и набор видов
async function giftStats(ids: number[]) {
  const GIFTS = await giftTypes();
  const m = new Map<number, { count: number; kinds: string[] }>();
  if (!ids.length) return m;
  const { data } = await db.from("gifts").select("to_id, kind").in("to_id", ids).not("claimed_at", "is", null);
  for (const g of data ?? []) {
    const s = m.get(g.to_id) ?? { count: 0, kinds: [] as string[] };
    s.count++;
    if (GIFTS[g.kind] && !s.kinds.includes(g.kind)) s.kinds.push(g.kind);
    m.set(g.to_id, s);
  }
  return m;
}
const giftBonus = (s?: { kinds: string[] }) => (s?.kinds ?? []).reduce((a, k) => a + giftXp(k), 0);
const monthStartIso = () => { const t = new Date(); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)).toISOString(); };
async function giftEnergy(me: number) {
  const { count } = await db.from("gifts").select("id", { count: "exact", head: true }).eq("from_id", me).neq("kind", "pro").not("kind", "in", `(${[...PRO_GIFTS].join(",")})`).gte("created_at", monthStartIso());   // v1.483: премиум-подарки энергию не тратят
  const t = new Date();
  const reset = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  const total = (me === ADMIN_TG_ID || (await proStatus(me)).active) ? GIFT_ENERGY_PRO : GIFT_ENERGY;
  return { left: Math.max(0, total - (count ?? 0)), total, reset };
}
async function myGifts(me: number) {
  const GIFTS = await giftTypes();
  const { data } = await db.from("gifts").select("id, from_id, kind, created_at, claimed_at").eq("to_id", me).order("id", { ascending: true });
  const ids = [...new Set((data ?? []).map((g: any) => g.from_id))];
  const us = await usersMap(ids as number[]);
  const row = (g: any) => ({ id: g.id, kind: GIFTS[g.kind] ? g.kind : "star", from_id: g.from_id, from_name: displayName(us.get(g.from_id)), at: g.created_at });
  const claimed = (data ?? []).filter((g: any) => g.claimed_at);
  const kinds = [...new Set(claimed.map((g: any) => g.kind).filter((k: string) => GIFTS[k]))];
  return { pending: (data ?? []).filter((g: any) => !g.claimed_at).map(row), claimed: claimed.map(row), kinds, xp: kinds.reduce((a: number, k: string) => a + giftXp(k), 0) };
}
const todayOf = (body: any) => dnum(String(body?.today ?? "")) ?? Math.floor(Date.now() / DAY);

async function routeFriends(body: any) {
  const GIFTS = await giftTypes();
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const today = todayOf(body);
  const [code, lr, ir, or, pr] = await Promise.all([myCode(me), db.from("friends").select("b, created_at").eq("a", me),
    db.from("friend_requests").select("from_id, created_at").eq("to_id", me), db.from("friend_requests").select("to_id").eq("from_id", me),
    db.from("friend_pokes").select("to_id, at").eq("from_id", me)]);
  const links = lr.data, inc = ir.data, out = or.data, pk = pr.data;
  const dead = await deactivatedSet([...new Set([...(links ?? []).map((l: any) => l.b), ...(inc ?? []).map((r: any) => r.from_id)])]);
  const ids = (links ?? []).map((l: any) => l.b).filter((id: number) => !dead.has(id));
  const incIds = (inc ?? []).map((r: any) => r.from_id).filter((id: number) => !dead.has(id));
  const all = [...new Set([me, ...ids, ...incIds])];
  const [users, by, gs] = await Promise.all([usersMap(all), loadRecs(all), giftStats(all)]);
  const card = (id: number) => {
    const u = users.get(id) ?? { tg_id: id };
    const g = gs.get(id);
    return { tg_id: id, name: displayName(u), username: u.username ?? null, handle: u.handle ?? null, private: !!u.private,
      frame: frameOf(by.get(id) ?? []), gifts: g?.count ?? 0, gift_kinds: g?.kinds ?? [], ...statsOf(by.get(id) ?? [], today, giftBonus(g)) };
  };
  const pokeWait = (id: number) => {
    const at = (pk ?? []).find((x: any) => x.to_id === id)?.at;
    if (!at) return 0;
    const left = POKE_HOURS * 3600000 - (Date.now() - new Date(at).getTime());
    return left > 0 ? Math.ceil(left / 3600000) : 0;
  };
  const friends = ids.map((id) => ({ ...card(id), since: (links ?? []).find((l: any) => l.b === id)?.created_at ?? null, poke_wait: pokeWait(id) }));
  const requests = incIds.map((id) => { const c = card(id); return { tg_id: id, name: c.name, username: c.username, handle: c.handle, level: c.level }; });
  const meCard = card(me);
  return json({ code: fmtCode(code), link: `https://t.me/${await botName()}?start=friend_${code}`,
    share: meCard.handle ? await shareLink(meCard.handle) : null, me: meCard,
    friends, requests, outgoing: (out ?? []).map((r: any) => r.to_id), my_gifts: await myGifts(me),
    gift_energy: await giftEnergy(me), gift_types: GIFTS });
}

async function routeFriendProfile(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const other = Number(body?.tg_id);
  if (!other) return fail("Нет друга");
  if (other !== me && (await deactivatedSet([other])).size) return fail("Пользователь не найден", 404);
  const today = todayOf(body);
  const [friendsOk, users, by, gsm, fc, theirs, mineArr, outR, incR] = await Promise.all([
    other === me ? Promise.resolve(true) : areFriends(me, other), usersMap([other]), loadRecs([other]), giftStats([other]),
    friendCount(other), friendIds(other), friendIds(me),
    db.from("friend_requests").select("to_id").eq("from_id", me), db.from("friend_requests").select("from_id").eq("to_id", me),
  ]);
  if (!friendsOk) return fail("Профиль доступен только друзьям", 403);
  const u = users.get(other) ?? { tg_id: other };
  const recs = by.get(other) ?? [];
  const g = gsm.get(other);
  const base = { tg_id: other, name: displayName(u), username: u.username ?? null, handle: u.handle ?? null, private: !!u.private,
    frame: frameOf(recs), gifts: g?.count ?? 0, gift_kinds: g?.kinds ?? [], ...statsOf(recs, today, giftBonus(g)) };
  if (u.private && other !== me) return json({ ...base, friends_count: fc, details: null, friends: null });
  const mine = new Set(mineArr);
  const outS = new Set((outR.data ?? []).map((r: any) => r.to_id)), incS = new Set((incR.data ?? []).map((r: any) => r.from_id));
  const [fu, fr, fgs] = await Promise.all([usersMap(theirs), loadRecs(theirs), giftStats(theirs)]);
  const list = theirs.map((id) => {
    const x = fu.get(id) ?? { tg_id: id };
    const xr = fr.get(id) ?? [];
    return { tg_id: id, name: displayName(x), username: x.username ?? null, handle: x.handle ?? null, frame: frameOf(xr),
      level: statsOf(xr, today, giftBonus(fgs.get(id))).level,
      state: id === me ? "me" : mine.has(id) ? "friend" : outS.has(id) ? "requested" : incS.has(id) ? "incoming" : "none" };
  }).sort((a, b) => (a.state === "me" ? -1 : b.state === "me" ? 1 : b.level.xp - a.level.xp));
  return json({ ...base, friends_count: fc, details: detailsOf(recs, today), friends: list });
}

// Публичная карточка по @username (из ссылки «Поделиться профилем»)
async function routePublicProfile(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const h = normHandle(body?.handle);
  if (!HANDLE_RE.test(h)) return json({ status: "notfound" });
  const { data: u } = await db.from("users").select("tg_id, first_name, username, handle, private").ilike("handle", h).maybeSingle();
  if (!u || (await deactivatedSet([u.tg_id])).size) return json({ status: "notfound" });
  const today = todayOf(body);
  const g = (await giftStats([u.tg_id])).get(u.tg_id);
  const pr = (await loadRecs([u.tg_id])).get(u.tg_id) ?? [];
  const st = statsOf(pr, today, giftBonus(g));
  let state = "none";
  if (u.tg_id === me) state = "me";
  else if (await areFriends(me, u.tg_id)) state = "friend";
  else {
    const { data: o } = await db.from("friend_requests").select("from_id").eq("from_id", me).eq("to_id", u.tg_id).maybeSingle();
    const { data: i } = await db.from("friend_requests").select("from_id").eq("from_id", u.tg_id).eq("to_id", me).maybeSingle();
    state = o ? "requested" : i ? "incoming" : "none";
  }
  return json({ status: "ok", tg_id: u.tg_id, name: displayName(u), handle: u.handle, private: !!u.private, state, frame: frameOf(pr),
    level: st.level, total: u.private ? null : st.total, gift_kinds: g?.kinds ?? [], friends_count: await friendCount(u.tg_id) });
}

async function routeHandle(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  if (body?.handle !== undefined) {
    const h = normHandle(body.handle);
    if (h === "") {
      await db.from("users").update({ handle: null }).eq("tg_id", me);
    } else {
      if (!HANDLE_RE.test(h)) return json({ status: "bad" });
      if (RESERVED.has(h.toLowerCase())) return json({ status: "taken" });
      const { data: other } = await db.from("users").select("tg_id").ilike("handle", h).maybeSingle();
      if (other && other.tg_id !== me) return json({ status: "taken" });
      const { error } = await db.from("users").update({ handle: h }).eq("tg_id", me);
      if (error) return json({ status: error.code === "23505" ? "taken" : "bad" });
    }
  }
  const u = await userInfo(me) as any;
  return json({ status: "ok", handle: u.handle ?? null, share: u.handle ? await shareLink(u.handle) : null });
}

async function routeFriendRequest(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const other = Number(body?.tg_id);
  if (!other || other === me) return json({ status: "self" });
  if (await areFriends(me, other)) return json({ status: "already" });
  const { data: target } = await db.from("users").select("handle").eq("tg_id", other).maybeSingle();
  if (!target || (await deactivatedSet([other])).size) return fail("Пользователь не найден", 404);
  // по ссылке «Поделиться профилем» можно постучаться к любому, у кого есть @username
  if (!target.handle) {
    const mine = await friendIds(me);
    const { data: common } = mine.length ? await db.from("friends").select("a").in("a", mine).eq("b", other) : { data: [] };
    if (!common?.length) return fail("Можно добавлять только друзей своих друзей", 403);
  }
  const { data: back } = await db.from("friend_requests").select("from_id").eq("from_id", other).eq("to_id", me).maybeSingle();
  const meU = await userInfo(me);
  if (back) {
    if ((await friendCount(me)) >= MAX_FRIENDS || (await friendCount(other)) >= MAX_FRIENDS) return json({ status: "limit" });
    await makeFriends(me, other);
    notify(other, `🎉 ${displayName(meU)} принял(а) заявку — теперь вы друзья в VOOB!`);
    return json({ status: "ok" });
  }
  await db.from("friend_requests").upsert({ from_id: me, to_id: other }, { onConflict: "from_id,to_id" });
  notify(other, `👋 ${displayName(meU)} хочет добавить тебя в друзья в VOOB.\n\nОткрой раздел «Друзья», чтобы принять или отклонить.`);
  return json({ status: "requested" });
}

async function routeFriendRespond(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const other = Number(body?.tg_id);
  const { data: req } = await db.from("friend_requests").select("from_id").eq("from_id", other).eq("to_id", me).maybeSingle();
  if (!req) return json({ status: "gone" });
  if (!body?.accept) {
    await db.from("friend_requests").delete().eq("from_id", other).eq("to_id", me);
    return json({ status: "declined" });
  }
  if ((await friendCount(me)) >= MAX_FRIENDS || (await friendCount(other)) >= MAX_FRIENDS) return json({ status: "limit" });
  await makeFriends(me, other);
  notify(other, `🎉 ${displayName(await userInfo(me))} принял(а) твою заявку — теперь вы друзья в VOOB!`);
  return json({ status: "ok" });
}

const POKE_TEXTS = [
  "⚡ {n} взбадривает тебя: самое время размяться!",
  "⚡ {n} напоминает: немного движения — и день удался.",
  "🔥 {n} уже в деле. Догоняй!",
  "😏 {n} заметил(а), что ты давно не заходил(а). Покажешь, на что способен?",
];
async function routeFriendPoke(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const other = Number(body?.tg_id);
  if (!other || !(await areFriends(me, other))) return fail("Взбодрить можно только друзей", 403);
  const { data: last } = await db.from("friend_pokes").select("at").eq("from_id", me).eq("to_id", other).maybeSingle();
  if (last?.at) {
    const left = POKE_HOURS * 3600000 - (Date.now() - new Date(last.at).getTime());
    if (left > 0) return json({ status: "soon", hours: Math.ceil(left / 3600000) });
  }
  await db.from("friend_pokes").upsert({ from_id: me, to_id: other, at: new Date().toISOString() }, { onConflict: "from_id,to_id" });
  const name = displayName(await userInfo(me));
  const t = POKE_TEXTS[Math.floor(Math.random() * POKE_TEXTS.length)].replace("{n}", name);
  const r = await tg("sendMessage", { chat_id: other, text: t, reply_markup: openBtnMk() }).catch(() => null);
  return json({ status: r?.ok === false ? "undelivered" : "ok", hours: POKE_HOURS });
}

async function routeGiftSend(body: any) {
  const GIFTS = await giftTypes();
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const other = Number(body?.tg_id);
  const kind = String(body?.kind ?? "");
  if (!GIFTS[kind]) return fail("Неизвестный подарок");
  if (kind === "pro") return fail("PRO дарится через оплату звёздами", 400);
  if (!other || other === me || !(await areFriends(me, other))) return fail("Дарить можно только друзьям", 403);
  if ((await deactivatedSet([other])).size) return fail("Пользователь недоступен", 404);
  if (PRO_GIFTS.has(kind) && me !== ADMIN_TG_ID && !(await proStatus(me)).active) return json({ status: "pro" });
  const en = await giftEnergy(me);
  if (en.left <= 0 && !PRO_GIFTS.has(kind)) return json({ status: "energy", energy: en });
  const { error } = await db.from("gifts").insert({ from_id: me, to_id: other, kind });
  if (error) return fail("Ошибка записи: " + error.message, 500);
  const { data: had } = await db.from("gifts").select("id").eq("to_id", other).eq("kind", kind).not("claimed_at", "is", null).limit(1);
  const [emo, title] = GIFTS[kind];
  const bonus = had?.length ? "" : `\n\nЭто первый такой подарок — +${giftXp(kind)} очков к уровню!`;
  notify(other, `🎁 ${displayName(await userInfo(me))} дарит тебе ${emo} «${title}»!${bonus}\n\nОткрой VOOB, чтобы получить подарок.`);
  return json({ status: "ok", energy: await giftEnergy(me) });
}

async function routeGiftClaim(body: any) {
  const GIFTS = await giftTypes();
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const id = Number(body?.id);
  const { data: g } = await db.from("gifts").select("id, from_id, to_id, kind, claimed_at").eq("id", id).maybeSingle();
  if (!g || g.to_id !== me) return fail("Подарок не найден", 404);
  let first = false;
  if (!g.claimed_at) {
    const { data: had } = await db.from("gifts").select("id").eq("to_id", me).eq("kind", g.kind).not("claimed_at", "is", null).limit(1);
    first = !had?.length;
    await db.from("gifts").update({ claimed_at: new Date().toISOString() }).eq("id", id);
    const [emo, title] = GIFTS[g.kind] ?? GIFTS.star ?? ["🎁", "Подарок"];
    notify(g.from_id, `${emo} ${displayName(await userInfo(me))} получил(а) твой подарок «${title}». Приятно, правда?`);
  }
  return json({ status: "ok", first, xp: first ? giftXp(g.kind) : 0, gifts: await myGifts(me) });
}

/* ---------- жалобы и идеи ---------- */
const FB_TITLE: Record<string, string> = { idea: "💡 Идея", bug: "🐞 Ошибка", complaint: "😤 Жалоба", user: "🚩 Жалоба на пользователя" };
async function routeFeedback(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const type = String(body?.type ?? "");
  const text = String(body?.text ?? "").trim().slice(0, 1000);
  if (!FB_TITLE[type]) return fail("Неизвестный тип");
  if (text.length < 3) return json({ status: "short" });
  const target = type === "user" ? Number(body?.target_id) || null : null;
  if (type === "user" && !target) return fail("Нет пользователя");
  const { count } = await db.from("feedback").select("id", { count: "exact", head: true }).eq("from_id", me)
    .gte("created_at", new Date(Date.now() - DAY).toISOString());
  if ((count ?? 0) >= FEEDBACK_PER_DAY) return json({ status: "limit" });
  const app = String(body?.app ?? "").slice(0, 60);
  const { error } = await db.from("feedback").insert({ from_id: me, type, target_id: target, text, app });
  if (error) return fail("Ошибка записи: " + error.message, 500);
  if (ADMIN_TG_ID) {
    const u = await userInfo(me) as any;
    let who = `${displayName(u)}${u.handle ? " @" + u.handle : ""} (id ${me})`;
    let tgt = "";
    if (target) { const t = await userInfo(target) as any; tgt = `\nНа кого: ${displayName(t)}${t.handle ? " @" + t.handle : ""} (id ${target})`; }
    tg("sendMessage", { chat_id: ADMIN_TG_ID, text: `${FB_TITLE[type]} · VOOB\nОт: ${who}${tgt}\n${app}\n\n${text}` }).catch(() => {});
  }
  return json({ status: "ok" });
}

async function routeFriendPrivacy(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const upd: Record<string, boolean> = {};
  if (typeof body?.private === "boolean") upd.private = body.private;
  if (typeof body?.hide_feed === "boolean") upd.hide_feed = body.hide_feed;
  if (Object.keys(upd).length) await db.from("users").update(upd).eq("tg_id", me);
  const { data } = await db.from("users").select("private, hide_feed").eq("tg_id", me).maybeSingle();
  return json({ private: !!data?.private, hide_feed: !!data?.hide_feed });
}

async function routeFriendAdd(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const r = await linkFriends(me, body?.code);
  return json({ status: r.status, name: r.owner ? displayName(r.owner) : null });
}

async function routeFriendRemove(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const other = Number(body?.tg_id);
  if (!other) return fail("Нет друга");
  await db.from("friends").delete().or(`and(a.eq.${me},b.eq.${other}),and(a.eq.${other},b.eq.${me})`);
  return json({ ok: true });
}

async function canSeePhoto(me: number, other: number) {
  if (other === me || (await areFriends(me, other))) return true;
  const { data: u } = await db.from("users").select("handle").eq("tg_id", other).maybeSingle();
  if (u?.handle) return true;
  const mine = await friendIds(me);
  if (mine.length) {
    const { data } = await db.from("friends").select("a").in("a", mine).eq("b", other).limit(1);
    if (data?.length) return true;
  }
  const { data: rq } = await db.from("friend_requests").select("from_id").eq("from_id", other).eq("to_id", me).maybeSingle();
  return !!rq;
}

async function photoB64(userId: number, big: boolean) {
  const ph = await tg("getUserProfilePhotos", { user_id: userId, limit: 1 });
  const sizes: any[] = ph?.result?.photos?.[0] ?? [];
  if (!ph?.ok || !sizes.length) return { ok: false, reason: "no_photo" };
  const best = big ? sizes.reduce((a, b) => (Math.abs(b.width - 640) < Math.abs(a.width - 640) ? b : a))
    : (sizes.find((s) => s.width >= 150) ?? sizes[sizes.length - 1]);
  const f = await tg("getFile", { file_id: best.file_id });
  if (!f?.ok || !f.result?.file_path) return { ok: false, reason: "no_file" };
  const r = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.result.file_path}`);
  if (!r.ok) return { ok: false, reason: "download" };
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { ok: true, mime: "image/jpeg", width: best.width, b64: btoa(bin) };
}

async function routeFriendPhoto(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const other = Number(body?.tg_id);
  if (!(await canSeePhoto(me, other))) return fail("Нет доступа", 403);
  return json(await photoB64(other, !!body?.big));
}

async function routeSetup(req: Request) {
  if (!BOT_TOKEN) return new Response("Нет секрета TELEGRAM_BOT_TOKEN в Supabase", { status: 500 });
  const base = new URL(req.url);
  const slug = new URL(req.url).pathname.match(/\/(steps)(\/|$)/i)?.[1] ?? "steps";
  const url = `${SB_URL}/functions/v1/${slug}/bot`;
  const r = await tg("setWebhook", {
    url, secret_token: await webhookSecret(), allowed_updates: ["message", "pre_checkout_query"], drop_pending_updates: true,
  });
  await tg("setMyCommands", { commands: [
    { command: "start", description: "Открыть VOOB" },
    { command: "pro", description: "VOOB PRO: статус и покупка" },
    { command: "paysupport", description: "Помощь с оплатой" },
  ] });
  const me = await tg("getMe", {});
  const ok = r.ok ? "✅ Бот подключён (сообщения + оплата Stars)" : "❌ Ошибка: " + (r.description ?? "неизвестно");
  return new Response(`${ok}\nБот: @${me?.result?.username ?? "?"}\nWebhook: ${url}\n(${base.host})`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function routeBot(req: Request) {
  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!safeEqual(got, await webhookSecret())) return new Response("forbidden", { status: 403 });
  const upd = await req.json().catch(() => null);
  if (upd?.pre_checkout_query) { await onPreCheckout(upd.pre_checkout_query); return new Response("ok"); }
  const msg = upd?.message;
  if (!msg?.from || !msg.chat) return new Response("ok");
  if (msg.successful_payment) { await onPaid(msg); return new Response("ok"); }
  const text: string = msg.text ?? "";
  const openBtn = openBtnMk();

  if (/^\/pro(@\w+)?$/.test(text)) {
    await upsertUser(msg.from);
    const st = await proStatus(msg.from.id);
    const head = st.active ? `👑 PRO активен до ${fmtRu(st.until!)} (осталось ${st.days_left} дн.)` : "PRO пока не подключён.";
    const rows: any[] = [];
    for (const p of st.plans) {
      const r = await tg("createInvoiceLink", { title: p.title, description: `PRO на ${p.days} дн.` + (p.bonus_days ? ` + ${p.bonus_days} дн. в подарок` : ""),
        payload: `pro:${p.plan}:${msg.from.id}`, provider_token: "", currency: "XTR", prices: [{ label: p.title, amount: p.stars }] });
      if (r?.ok) rows.push([{ text: `${p.plan === "year" ? "Год" : "Месяц"} · ${p.stars}⭐` + (p.bonus_days ? ` (+${p.bonus_days} дн.)` : ""), url: r.result }]);
    }
    await tg("sendMessage", { chat_id: msg.chat.id, text: `${head}\n\n${st.active ? "Продлить:" : "Подключить:"}`, reply_markup: { inline_keyboard: rows } });
    return new Response("ok");
  }
  if (/^\/paysupport(@\w+)?$/.test(text)) {
    await tg("sendMessage", { chat_id: msg.chat.id, text: "Помощь с оплатой VOOB PRO.\n\nОпиши проблему одним сообщением через «Идеи и жалобы» в программе (Профиль → Ник и профиль) или напиши разработчику. Если PRO не включился после оплаты — он включится вручную или звёзды вернутся.\n\nУсловия: PRO продлевает доступ к дополнительным функциям на оплаченный срок; автопродления нет." });
    return new Response("ok");
  }
  const rf = text.match(/^\/refund\s+(\S+)$/);
  if (rf && ADMIN_TG_ID && msg.from.id === ADMIN_TG_ID) { await adminRefund(msg.chat.id, rf[1]); return new Response("ok"); }

  const m = text.match(/^\/start\s+login_([A-Z0-9]{8,32})$/);
  if (m) {
    const code = m[1];
    const since = new Date(Date.now() - CODE_TTL_MIN * 60000).toISOString();
    const { data } = await db.from("login_codes").select("code, tg_id, created_at")
      .eq("code", code).gte("created_at", since).maybeSingle();
    if (!data || data.tg_id) {
      await tg("sendMessage", { chat_id: msg.chat.id, text: "Код входа устарел или уже использован. Нажми «Войти через Telegram» в программе ещё раз." });
      return new Response("ok");
    }
    await upsertUser(msg.from);
    await db.from("login_codes").update({ tg_id: msg.from.id, claimed_at: new Date().toISOString() }).eq("code", code);
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: `✅ Готово, ${msg.from.first_name ?? "друг"}!\n\nВернись в VOOB на компьютере — синхронизация включится сама через пару секунд.`,
    });
    return new Response("ok");
  }

  const fm = text.match(/^\/start\s+friend_([A-Z0-9]{6,16})$/);
  if (fm) {
    await upsertUser(msg.from);
    const r = await linkFriends(msg.from.id, fm[1]);
    const who = r.owner ? displayName(r.owner) : "";
    const t = r.status === "ok" ? `✅ Готово! Теперь вы с ${who} друзья в VOOB.\n\nОткрой раздел «Друзья», чтобы смотреть успехи друг друга.`
      : r.status === "already" ? `Вы с ${who} уже друзья 🙂`
      : r.status === "self" ? "Это твоя собственная ссылка-приглашение 🙂 Отправь её другу."
      : r.status === "limit" ? "Слишком много друзей — максимум 100."
      : "Приглашение не найдено. Попроси друга прислать ссылку ещё раз.";
    await tg("sendMessage", { chat_id: msg.chat.id, text: t, reply_markup: openBtn });
    return new Response("ok");
  }

  if (text.startsWith("/start")) {
    await upsertUser(msg.from);
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: `Привет, ${msg.from.first_name ?? "друг"} ⚡\n\nVOOB — трекер тренировок, в котором приятно жить.\nЗапиши первую тренировку!`,
      reply_markup: openBtn,
    });
    return new Response("ok");
  }

  await tg("sendMessage", { chat_id: msg.chat.id, text: "Я не умею болтать, зато умею открывать VOOB 🙂", reply_markup: openBtn });
  return new Response("ok");
}

async function routeWebApp(body: any) {
  const user = await verifyInitData(String(body?.initData ?? ""));
  if (!user) return fail("Подпись Telegram не прошла проверку", 401);
  await purgeDue().catch(() => {});
  await upsertUser(user);
  const token = await createSession(user.id, "miniapp");
  return json({ token, user: await userInfo(user.id) });
}

async function routeLoginStart() {
  await db.from("login_codes").delete().lt("created_at", new Date(Date.now() - 86400000).toISOString());
  const code = randomCode();
  const { error } = await db.from("login_codes").insert({ code });
  if (error) return fail("Не удалось создать код", 500);
  return json({ code, link: `https://t.me/${await botName()}?start=login_${code}`, expires_in: CODE_TTL_MIN * 60 });
}

async function routeLoginPoll(body: any) {
  const code = String(body?.code ?? "");
  if (!/^[A-Z0-9]{8,32}$/.test(code)) return fail("Неверный код");
  const since = new Date(Date.now() - CODE_TTL_MIN * 60000).toISOString();
  const { data } = await db.from("login_codes").select("tg_id, created_at").eq("code", code).maybeSingle();
  if (!data || data.created_at < since) return json({ status: "expired" });
  if (!data.tg_id) return json({ status: "pending" });
  await db.from("login_codes").delete().eq("code", code);
  const token = await createSession(data.tg_id, "desktop");
  return json({ status: "ok", token, user: await userInfo(data.tg_id) });
}

async function routeSync(body: any) {
  const tgId = await sessionUser(body?.token);
  if (!tgId) return noSession();
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  if (rows.length > MAX_ROWS) return fail(`Слишком много записей за раз (максимум ${MAX_ROWS})`);
  let pushed = 0;
  purgeDue().catch(() => {});
  const frozenNow = await isLocked(tgId);          // М6: во время заморозки записи не принимаются
  if (rows.length && !frozenNow) {
    const { data, error } = await db.rpc("sync_push", { p_tg: tgId, p_rows: rows });
    if (error) return fail("Ошибка записи: " + error.message, 500);
    pushed = data ?? 0;
  }
  const since = Number(body?.since ?? 0) || 0;
  const out: any[] = [];
  let cursor = since;
  for (let i = 0; i < 20; i++) {
    const { data, error } = await db.from("records").select("kind, id, data, updated, deleted, rev")
      .eq("tg_id", tgId).gt("rev", cursor).order("rev", { ascending: true }).limit(1000);
    if (error) return fail("Ошибка чтения: " + error.message, 500);
    if (!data?.length) break;
    out.push(...data);
    cursor = data[data.length - 1].rev;
    if (data.length < 1000) break;
  }
  let gifts = null, pro = null;
  try { gifts = await myGifts(tgId); } catch { gifts = null; }
  try { pro = await proStatus(tgId); } catch { pro = null; }
  return json({ pushed, rows: out, rev: cursor, user: await userInfo(tgId), server_time: Date.now(), gifts, pro, frozen: frozenNow });
}

async function routeAvatar(body: any) {
  const tgId = await sessionUser(body?.token);
  if (!tgId) return noSession();
  return json(await photoB64(tgId, true));
}

const PIN_TTL_MIN = 10, PIN_TRIES = 5;
async function routePinStart(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const { data: old } = await db.from("pin_resets").select("created_at").eq("tg_id", me).maybeSingle();
  if (old && Date.now() - new Date(old.created_at).getTime() < 60000) return json({ status: "soon" });
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 10000;
  const code = String(n).padStart(4, "0");
  await db.from("pin_resets").upsert({ tg_id: me, code_hash: await sha256("pin:" + me + ":" + code), tries: 0,
    created_at: new Date().toISOString() }, { onConflict: "tg_id" });
  const r = await tg("sendMessage", { chat_id: me, parse_mode: "HTML",
    text: `🔑 Код для сброса PIN в VOOB на компьютере: <b>${code}</b>\n\nДействует ${PIN_TTL_MIN} минут. Если это не ты — просто проигнорируй сообщение.` }).catch(() => null);
  return json({ status: r?.ok ? "sent" : "undelivered", ttl: PIN_TTL_MIN * 60 });
}
async function routePinVerify(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const code = String(body?.code ?? "").trim();
  const { data: r } = await db.from("pin_resets").select("code_hash, tries, created_at").eq("tg_id", me).maybeSingle();
  if (!r || Date.now() - new Date(r.created_at).getTime() > PIN_TTL_MIN * 60000) return json({ status: "expired" });
  if (r.tries >= PIN_TRIES) return json({ status: "locked" });
  if (!/^\d{4}$/.test(code) || !safeEqual(await sha256("pin:" + me + ":" + code), r.code_hash)) {
    await db.from("pin_resets").update({ tries: r.tries + 1 }).eq("tg_id", me);
    return json({ status: r.tries + 1 >= PIN_TRIES ? "locked" : "wrong", left: PIN_TRIES - r.tries - 1 });
  }
  await db.from("pin_resets").delete().eq("tg_id", me);
  return json({ status: "ok" });
}

/* ---------- М6: коды из бота для заморозки / разморозки ---------- */
const ACT_TTL_MIN = 10, ACT_TRIES = 5;
async function routeFreezeStart(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const action = ["unfreeze", "delete"].includes(body?.action) ? body.action : "freeze";
  const st = await proStatus(me);
  if (action === "freeze" && !st.can_freeze) return fail(st.frozen ? "Подписка уже заморожена" : "Заморозка недоступна", 409);
  if (action === "unfreeze" && !st.frozen) return fail("Подписка не заморожена", 409);
  if (action === "delete" && st.del_at) return fail("Удаление уже запланировано", 409);
  const { data: old } = await db.from("action_codes").select("created_at").eq("tg_id", me).eq("action", action).maybeSingle();
  if (old && Date.now() - new Date(old.created_at).getTime() < 60000) return json({ status: "soon", ttl: ACT_TTL_MIN * 60 });
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");
  await db.from("action_codes").upsert({ tg_id: me, action, code_hash: await sha256(`act:${action}:${me}:${code}`), tries: 0,
    created_at: new Date().toISOString() }, { onConflict: "tg_id,action" });
  const text = action === "delete"
    ? `🗑 Код для удаления аккаунта VOOB: <b>${code}</b>\n\nАккаунт сразу отключится, а через ${DELETE_GRACE_DAYS} дней все тренировки, друзья, подарки и настройки будут удалены безвозвратно. До этого можно передумать и отменить удаление в приложении. Оплаченные звёзды не возвращаются автоматически.\n\nДействует ${ACT_TTL_MIN} минут. Если это не ты — не называй код никому и проигнорируй сообщение.`
    : action === "freeze"
    ? `❄️ Код для заморозки VOOB PRO: <b>${code}</b>\n\nПодписка встанет на паузу на ${st.freeze_days} дн., оставшиеся дни сохранятся. Пока идёт заморозка, данные в приложении можно только смотреть. Заморозка доступна один раз.\n\nДействует ${ACT_TTL_MIN} минут. Если это не ты — проигнорируй сообщение.`
    : `☀️ Код для разморозки VOOB PRO: <b>${code}</b>\n\nПодписка продолжится с того места, где остановилась.\n\nДействует ${ACT_TTL_MIN} минут. Если это не ты — проигнорируй сообщение.`;
  const r = await tg("sendMessage", { chat_id: me, parse_mode: "HTML", text }).catch(() => null);
  return json({ status: r?.ok ? "sent" : "undelivered", ttl: ACT_TTL_MIN * 60 });
}
async function routeFreezeVerify(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const action = ["unfreeze", "delete"].includes(body?.action) ? body.action : "freeze";
  const code = String(body?.code ?? "").trim();
  const { data: r } = await db.from("action_codes").select("code_hash, tries, created_at").eq("tg_id", me).eq("action", action).maybeSingle();
  if (!r || Date.now() - new Date(r.created_at).getTime() > ACT_TTL_MIN * 60000) return json({ status: "expired" });
  if (r.tries >= ACT_TRIES) return json({ status: "locked" });
  if (!/^\d{4}$/.test(code) || !safeEqual(await sha256(`act:${action}:${me}:${code}`), r.code_hash)) {
    await db.from("action_codes").update({ tries: r.tries + 1 }).eq("tg_id", me).eq("action", action);
    return json({ status: r.tries + 1 >= ACT_TRIES ? "locked" : "wrong", left: ACT_TRIES - r.tries - 1 });
  }
  await db.from("action_codes").delete().eq("tg_id", me).eq("action", action);
  if (action === "delete") {
    const at = new Date(Date.now() + DELETE_GRACE_DAYS * DAY).toISOString();
    const { data: u } = await db.from("users").select("hide_feed, delete_at").eq("tg_id", me).maybeSingle();
    if (u?.delete_at) return fail("Удаление уже запланировано", 409);
    await db.from("users").update({ delete_at: at, hide_feed_prev: !!u?.hide_feed, hide_feed: true }).eq("tg_id", me);
    tg("sendMessage", { chat_id: me, parse_mode: "HTML", reply_markup: openBtnMk(),
      text: `🗑 Аккаунт VOOB отключён и будет удалён <b>${fmtRu(at)}</b>.\n\nДо этого дня можно передумать: открой приложение и нажми «Отменить удаление».` }).catch(() => {});
    return json({ status: "ok", scheduled: true, delete_at: at, pro: await proStatus(me) });
  }
  const { data: row } = await db.from("pro_subs").select(SUB_COLS).eq("tg_id", me).maybeSingle();
  const st = await proStatus(me);
  if (action === "freeze") {
    if (!row || !st.can_freeze) return fail("Заморозка недоступна", 409);
    const to = await doFreeze(me, row);
    tg("sendMessage", { chat_id: me, parse_mode: "HTML", reply_markup: openBtnMk(),
      text: `❄️ VOOB PRO заморожен до <b>${fmtRu(to)}</b>. Оставшиеся дни сохранены. Разморозить раньше можно в приложении.` }).catch(() => {});
  } else {
    if (!row?.frozen_at) return fail("Подписка не заморожена", 409);
    const u = await doUnfreeze(me, row, false);
    tg("sendMessage", { chat_id: me, parse_mode: "HTML", reply_markup: openBtnMk(),
      text: `☀️ VOOB PRO снова активен до <b>${fmtRu(u.until)}</b>.` }).catch(() => {});
  }
  return json({ status: "ok", pro: await proStatus(me) });
}

async function routeAccountRestore(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return noSession();
  const { data: u } = await db.from("users").select("delete_at, hide_feed_prev").eq("tg_id", me).maybeSingle();
  if (!u?.delete_at) return json({ status: "none", pro: await proStatus(me) });
  await db.from("users").update({ delete_at: null, hide_feed: !!u.hide_feed_prev, hide_feed_prev: null }).eq("tg_id", me);
  tg("sendMessage", { chat_id: me, reply_markup: openBtnMk(), text: "✅ Удаление отменено — аккаунт VOOB снова активен. С возвращением!" }).catch(() => {});
  return json({ status: "ok", pro: await proStatus(me) });
}

const FROZEN_BLOCK = new Set(["/friends/add", "/friends/remove", "/friends/request", "/friends/respond", "/friends/privacy",
  "/friends/poke", "/gifts/send", "/gifts/claim", "/profile/handle"]);

async function routeLogout(body: any) {
  if (typeof body?.token === "string") await db.from("sessions").delete().eq("token_hash", await sha256(body.token));
  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const m = path.match(/\/steps(\/.*)?$/i);
  const route = (m?.[1] ?? "/").toLowerCase();
  try {
    if (route === "/setup" && req.method === "GET") return await routeSetup(req);
    if (route === "/bot" && req.method === "POST") return await routeBot(req);
    if (req.method !== "POST") return json({ app: "VOOB sync", version: "1.453", pro: true, ok: true });
    const body = await req.json().catch(() => ({}));
    if (FROZEN_BLOCK.has(route)) {                       // М6: пока подписка заморожена — только просмотр
      const who = await sessionUser(body?.token);
      if (who && await isLocked(who)) return fail("Аккаунт на паузе — изменения временно недоступны", 423);
    }
    switch (route) {
      case "/tg-webapp": return await routeWebApp(body);
      case "/login/start": return await routeLoginStart();
      case "/login/poll": return await routeLoginPoll(body);
      case "/sync": return await routeSync(body);
      case "/logout": return await routeLogout(body);
      case "/avatar": return await routeAvatar(body);
      case "/friends": return await routeFriends(body);
      case "/friends/add": return await routeFriendAdd(body);
      case "/friends/remove": return await routeFriendRemove(body);
      case "/friends/photo": return await routeFriendPhoto(body);
      case "/friends/profile": return await routeFriendProfile(body);
      case "/friends/request": return await routeFriendRequest(body);
      case "/friends/respond": return await routeFriendRespond(body);
      case "/friends/privacy": return await routeFriendPrivacy(body);
      case "/friends/poke": return await routeFriendPoke(body);
      case "/gifts/send": return await routeGiftSend(body);
      case "/gifts/claim": return await routeGiftClaim(body);
      case "/profile/handle": return await routeHandle(body);
      case "/profile/public": return await routePublicProfile(body);
      case "/feedback": return await routeFeedback(body);
      case "/pro/status": return await routeProStatus(body);
      case "/pin/reset/start": return await routePinStart(body);
      case "/pin/reset/verify": return await routePinVerify(body);
      case "/pro/invoice": return await routeProInvoice(body);
      case "/pro/freeze/start": return await routeFreezeStart(body);
      case "/pro/freeze/verify": return await routeFreezeVerify(body);
      case "/account/restore": return await routeAccountRestore(body);
    }
    return fail("Неизвестный маршрут " + route, 404);
  } catch (e) {
    console.error(e);
    return fail("Внутренняя ошибка сервера", 500);
  }
});
