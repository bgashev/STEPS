// VOOB — лента активности друзей (Supabase Edge Function «voob-feed») · v1.1062 (свои активности друзей: проверка по шаблону и название в событии)
import { createClient } from "npm:@supabase/supabase-js@2";

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
const db = createClient(SB_URL, serverKey(), { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

const enc = new TextEncoder();
const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((x) => x.toString(16).padStart(2, "0")).join("");

async function sessionUser(token: unknown): Promise<number | null> {
  if (typeof token !== "string" || token.length < 20) return null;
  const { data } = await db.from("sessions").select("tg_id").eq("token_hash", await sha256(token)).maybeSingle();
  return data ? (data.tg_id as number) : null;
}
const displayName = (u: any) => u?.first_name || (u?.handle ? "@" + u.handle : u?.username ? "@" + u.username : "Друг");

// анти-чит: те же правила, что в основной функции
const AC = { minMin: 1, maxMin: 240, minSpeed: 0.5, maxSpeed: 20, maxIncline: 15, dayMin: 300, dayCount: 6, lateDays: 3 };
const STR: Record<string, { per: string; max: number }> = {
  pushup: { per: "reps", max: 200 }, squat: { per: "reps", max: 300 }, pullup: { per: "reps", max: 100 },
  plank: { per: "secs", max: 900 }, dumbbell: { per: "reps", max: 100 }, burpee: { per: "reps", max: 100 },
  barbell: { per: "reps", max: 100 }, abs: { per: "reps", max: 300 },
};
const TIME: Record<string, number> = { bike: 45, yoga: 0, jumprope: 0, stepper: 0, swim: 0 };   // макс. скорость
// v1.1062: свои активности — шаблон определяет, что считается (так же, как в основной функции)
const CTPL: Record<string, { per?: string; max: number; time?: boolean }> = {
  reps: { per: "reps", max: 100 }, rw: { per: "reps", max: 100 }, hold: { per: "secs", max: 600 }, time: { time: true, max: 240 },
};
const cactOk = (id: string, d: any) => /^c\d{4,12}_\d{1,6}$/.test(id) && d && typeof d === "object" && CTPL[d.tpl] && typeof d.name === "string"
  && d.name.trim().length >= 2 && d.name.trim().length <= 18 && typeof d.icon === "string" && /^[a-z]{2,14}$/.test(d.icon)
  && typeof d.color === "string" && (/^#[0-9a-fA-F]{6}$/.test(d.color) || /^hsl\(\d{1,3} 68% 72%\)$/.test(d.color));
const DAY = 86400000;
const dnum = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY) : null;
};
function fieldsOk(w: any, today: number, cx: Record<string, string> = {}) {
  const d = dnum(w.date), m = Number(w.minutes), s = Number(w.speed), i = Number(w.incline ?? 0);
  if (d === null || d > today) return false;
  if (!(m >= AC.minMin && m <= AC.maxMin)) return false;
  const ct = CTPL[cx[w.act]];
  const st = STR[w.act] ?? (ct?.per ? { per: ct.per, max: ct.max } : undefined);
  if (st) {
    const n = Number(w.sets), v = Number(st.per === "reps" ? w.reps : w.secs), kg = Number(w.kg ?? 0);
    if (Array.isArray(w.sl)) {
      if (!(w.sl.length >= 1 && w.sl.length <= 20 && w.sl.length === n)) return false;
      if (!w.sl.every((x: any) => Number.isInteger(Number(x)) && Number(x) >= 1 && Number(x) <= st.max)) return false;
    } else if (!(Number.isInteger(n) && n >= 1 && n <= 20 && v >= 1 && v <= st.max)) return false;
    if (!(kg >= 0 && kg <= 150)) return false;
    const c0 = Number(w.created) || 0;
    return !(c0 > 0 && Math.floor(c0 * 1000 / DAY) - d > AC.lateDays);
  }
  if (w.act in TIME || ct?.time) {
    if (!(s >= 0 && s <= (ct?.time ? 0 : TIME[w.act]))) return false;
  } else {
    if (!(s >= AC.minSpeed && s <= AC.maxSpeed)) return false;
    if (!(i >= 0 && i <= AC.maxIncline)) return false;
  }
  const c = Number(w.created) || 0;
  if (c > 0 && Math.floor(c * 1000 / DAY) - d > AC.lateDays) return false;
  return true;
}
function honest(ws: any[], today: number, cx: Record<string, string> = {}) {
  const ok = ws.filter((w) => fieldsOk(w, today, cx))
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

const FEED_DAYS = 14;
const FEED_MAX = 80;
// подарок «от VOOB» (промокод, объявление, VOOB Core) создаётся сразу полученным: claimed_at почти совпадает с created_at.
// Личный подарок друг забирает позже сам — у него эта разница всегда заметно больше.
const isSystemGift = (g: any) => !!g.claimed_at && !!g.created_at && Date.parse(g.claimed_at) - Date.parse(g.created_at) < 3000;
const VOOB_FROM = { tg_id: 0, name: "VOOB", handle: null, me: false, voob: true };

async function feed(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return json({ error: "Сессия недействительна — войди заново" }, 401);
  const today = dnum(String(body?.today ?? "")) ?? Math.floor(Date.now() / DAY);
  const sinceDay = today - FEED_DAYS + 1;
  const sinceIso = new Date(sinceDay * DAY).toISOString();

  const { data: links } = await db.from("friends").select("b, created_at").eq("a", me);
  const fids = (links ?? []).map((l: any) => l.b);
  const ids = [me, ...fids];
  const { data: us } = await db.from("users").select("tg_id, first_name, username, handle, private, hide_feed").in("tg_id", ids);
  const users = new Map<number, any>((us ?? []).map((u: any) => [u.tg_id, u]));
  const who = (id: number) => {
    const u = users.get(id) ?? { tg_id: id };
    return { tg_id: id, name: displayName(u), handle: u.handle ?? null, me: id === me };
  };
  // закрытый профиль или «Скрывать мои новости в ленте» — событий человека в ленте друзей нет
  const hidden = (id: number) => id !== me && (!!users.get(id)?.private || !!users.get(id)?.hide_feed);
  const visible = ids.filter((id) => !hidden(id));

  const ev: any[] = [];
  // тренировки
  const recs: any[] = [];
  for (let from = 0; from < 50000 && visible.length; from += 1000) {
    const { data } = await db.from("records").select("tg_id, id, data, deleted").in("tg_id", visible)
      .eq("kind", "workout").range(from, from + 999);
    recs.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  // v1.1062: свои активности людей из ленты (по id вида c<tg>_<n>, чужие id не принимаем)
  const cacts = new Map<string, any>(), ctpl = new Map<number, Record<string, string>>();
  if (visible.length) {
    const { data: ca } = await db.from("records").select("tg_id, id, data, deleted").in("tg_id", visible).eq("kind", "cact").limit(2000);
    for (const r of ca ?? []) {
      const id = String(r.id);
      if (r.deleted || !id.startsWith(`c${r.tg_id}_`) || !cactOk(id, r.data)) continue;
      cacts.set(id, { n: String(r.data.name).trim(), i: r.data.icon, c: r.data.color, t: r.data.tpl, m: Number(r.data.inten) || 1 });
      if (!ctpl.has(r.tg_id)) ctpl.set(r.tg_id, {});
      ctpl.get(r.tg_id)![id] = r.data.tpl;
    }
  }
  const by = new Map<number, any[]>();
  for (const r of recs) if (!r.deleted) { if (!by.has(r.tg_id)) by.set(r.tg_id, []); by.get(r.tg_id)!.push({ ...(r.data || {}), _rid: r.id }); }
  for (const [id, ws] of by) {
    for (const w of honest(ws, today, ctpl.get(id) ?? {})) {
      const d = dnum(w.date)!;
      if (d < sinceDay) continue;
      const c = Number(w.created) || 0;
      const at = c > 0 ? new Date(c * 1000).toISOString() : new Date(d * DAY + 12 * 3600000).toISOString();
      ev.push({ type: "workout", at, user: who(id), post: "w:" + w._rid,
        data: { act: w.act || "run", date: w.date, minutes: Number(w.minutes) || 0, speed: Number(w.speed) || 0,
          incline: Number(w.incline) || 0, feel: w.feeling ?? null,
          sets: Number(w.sets) || 0, reps: Number(w.reps) || 0, secs: Number(w.secs) || 0, kg: Number(w.kg) || 0,
          ...(cacts.has(w.act) ? { ca: cacts.get(w.act) } : {}),
          ...(typeof w.ex === "string" && w.ex.length < 24 ? { ex: w.ex } : {}),
          ...(Array.isArray(w.sl) ? { sl: w.sl.slice(0, 20).map((x: any) => Number(x) || 0) } : {}) } });
    }
  }
  // подарки, полученные друзьями (и мной)
  const { data: gt } = await db.from("gift_types").select("kind, emoji, title");
  const gifts = new Map<string, any>((gt ?? []).map((g: any) => [g.kind, g]));
  const { data: gs } = visible.length ? await db.from("gifts").select("from_id, to_id, kind, claimed_at, created_at").in("to_id", visible)
    .gte("claimed_at", sinceIso).order("claimed_at", { ascending: false }).limit(60) : { data: [] };
  const extra = [...new Set((gs ?? []).filter((g: any) => !isSystemGift(g)).map((g: any) => g.from_id).filter((x: number) => !users.has(x)))];
  if (extra.length) {
    const { data: ex } = await db.from("users").select("tg_id, first_name, username, handle").in("tg_id", extra);
    for (const u of ex ?? []) users.set(u.tg_id, u);
  }
  for (const g of gs ?? []) {
    const t = gifts.get(g.kind);
    ev.push({ type: "gift", at: g.claimed_at, user: who(g.to_id),
      data: { kind: t ? g.kind : "star", emoji: t?.emoji ?? "🎁", title: t?.title ?? "Подарок", from: isSystemGift(g) ? VOOB_FROM : who(g.from_id) } });
  }
  // новые друзья
  for (const l of links ?? []) {
    if (l.created_at && l.created_at >= sinceIso && !hidden(l.b)) ev.push({ type: "friend", at: l.created_at, user: who(l.b), data: {} });
  }
  ev.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const out = ev.slice(0, FEED_MAX);
  // лайки: только для постов-тренировок
  const posts = out.filter((e) => e.post);
  if (posts.length) {
    const owners = [...new Set(posts.map((e) => e.user.tg_id))];
    const { data: lk } = await db.from("feed_likes").select("owner_id, post_id, from_id").in("owner_id", owners)
      .in("post_id", posts.map((e) => e.post));
    for (const e of posts) {
      const mine = (lk ?? []).filter((l: any) => l.owner_id === e.user.tg_id && l.post_id === e.post);
      e.likes = mine.length;
      e.liked = mine.some((l: any) => l.from_id === me);
    }
  }
  return json({ events: out, days: FEED_DAYS });
}

async function like(body: any) {
  const me = await sessionUser(body?.token);
  if (!me) return json({ error: "Сессия недействительна — войди заново" }, 401);
  const owner = Number(body?.owner_id), post = String(body?.post_id ?? "");
  if (!owner || owner === me || !/^w:[\w-]{1,64}$/.test(post)) return json({ error: "Нельзя" }, 400);
  const { data: fr } = await db.from("friends").select("a").eq("a", me).eq("b", owner).maybeSingle();
  if (!fr) return json({ error: "Лайкать можно только друзей" }, 403);
  if (body?.on === false) await db.from("feed_likes").delete().eq("owner_id", owner).eq("post_id", post).eq("from_id", me);
  else await db.from("feed_likes").upsert({ owner_id: owner, post_id: post, from_id: me }, { onConflict: "owner_id,post_id,from_id" });
  const { count } = await db.from("feed_likes").select("from_id", { count: "exact", head: true }).eq("owner_id", owner).eq("post_id", post);
  return json({ status: "ok", likes: count ?? 0, liked: body?.on !== false });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ app: "VOOB feed", version: "1.1062", ok: true });
  try {
    const body = await req.json().catch(() => ({}));
    return body?.action === "like" ? await like(body) : await feed(body);
  } catch (e) {
    console.error(e);
    return json({ error: "Внутренняя ошибка сервера" }, 500);
  }
});
