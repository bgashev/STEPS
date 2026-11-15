// VOOB — общая база продуктов для сканера штрихкодов (Supabase Edge Function voob-food) · v2
// Таблица: food_products(code pk, name, brand, k,p,f,c на 100 г/мл, u, src, conf, added_by).
// act: lookup {codes[]} · search {q} (без входа; отдаются только проверенные) · contribute {token, ...} (нужна сессия) · seed {key, country, from, to} (разовый импорт OFF).
// Правила доверия: значения из Open Food Facts сервер берёт сам и они главнее любых пользовательских; продукт, которого нет в OFF, остаётся pending, пока его независимо не подтвердят 2 разных человека.
import { createClient } from "npm:@supabase/supabase-js@2";

function serverKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); if (legacy) return legacy;
  const single = Deno.env.get("SUPABASE_SECRET_KEY"); if (single) return single;
  try { const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return all.default ?? Object.values(all)[0] ?? ""; } catch { return ""; }
}
const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", serverKey(), { auth: { persistSession: false } });
const enc = new TextEncoder();
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
const fail = (m: string, s = 400) => json({ error: m }, s);
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sessionUser(token: unknown): Promise<number | null> {
  if (typeof token !== "string" || token.length < 20) return null;
  const { data } = await db.from("sessions").select("tg_id").eq("token_hash", await sha256(token)).maybeSingle();
  return data ? (data.tg_id as number) : null;
}
const DAY_LIMIT = 80;
const UA = "VOOB-app/1.0 (Telegram Mini App, voob.kz)";
const pub = (r: any) => ({ code: r.code, name: r.name, brand: r.brand, k: +r.k, p: +r.p, f: +r.f, c: +r.c, u: r.u, src: r.src, conf: r.conf });
const n1 = (v: unknown, lo: number, hi: number) => { const x = Math.round(Number(v) * 10) / 10; return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
const esc = (s: string) => s.replace(/[%_\\]/g, (m) => "\\" + m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FIELDS = "code,product_name,product_name_ru,brands,nutriments,quantity,product_quantity_unit,categories_tags";

// Приводит продукт OFF к нашей строке. null — если калорий нет или данные нелепые.
function offRow(p: any, codeIn?: string) {
  if (!p) return null;
  const code = String(codeIn ?? p.code ?? "").replace(/\D/g, "");
  if (!/^[0-9]{6,14}$/.test(code)) return null;
  const n = p.nutriments ?? {};
  let k = n["energy-kcal_100g"] != null ? Number(n["energy-kcal_100g"]) : NaN;
  if (!(k >= 0)) { const kj = Number(n["energy_100g"]); k = kj > 0 ? kj / 4.184 : NaN; }
  const name = String(p.product_name_ru || p.product_name || "").replace(/\s+/g, " ").trim().slice(0, 90);
  if (!(k >= 0) || name.length < 2) return null;
  const brand = String(p.brands ?? "").split(",")[0].replace(/\s+/g, " ").trim().slice(0, 60);
  const pr = n1(n["proteins_100g"] ?? 0, 0, 100), f = n1(n["fat_100g"] ?? 0, 0, 100), c = n1(n["carbohydrates_100g"] ?? 0, 0, 100), kk = n1(k, 0, 950);
  if (pr === null || f === null || c === null || kk === null || pr + f + c > 105) return null;
  if (kk > 0 && Math.abs(kk - (pr * 4 + c * 4 + f * 9)) > Math.max(60, kk * 0.45)) return null;
  const q = String(p.quantity ?? "");
  const tags = (Array.isArray(p.categories_tags) ? p.categories_tags : []).join(" ");
  const liquid = /\d\s*(ml|мл|l|л)\b/i.test(q) || String(p.product_quantity_unit ?? "") === "ml" || /beverages|waters|sodas|juices|energy-drinks|kvass|drinks/.test(tags);
  const u = liquid && !/\d\s*(g|г|kg|кг)\b/i.test(q) ? "мл" : "г";
  return { code, name, brand, k: kk, p: pr, f, c, u, src: "off", status: "ok", conf: 1 };
}
async function offFetch(url: string, ms = 5000): Promise<any | null> {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" }, signal: ctl.signal }); return r.ok ? await r.json() : null; }
  catch { return null; } finally { clearTimeout(t); }
}
async function offByCode(code: string) {
  const j = await offFetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${FIELDS}`);
  return j && j.status === 1 ? offRow(j.product, code) : null;
}
const same = (a: string, b: string) => { const x = a.toLowerCase().replace(/[^a-zа-я0-9]/g, ""), y = b.toLowerCase().replace(/[^a-zа-я0-9]/g, ""); return x.length > 2 && y.length > 2 && (x.includes(y) || y.includes(x) || x.slice(0, 4) === y.slice(0, 4)); };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail("method", 405);
  let b: any; try { b = await req.json(); } catch { return fail("json"); }
  const act = String(b?.act ?? "");

  if (act === "lookup") {
    const codes = (Array.isArray(b.codes) ? b.codes : []).map(String).filter((c: string) => /^[0-9]{6,14}$/.test(c)).slice(0, 6);
    if (!codes.length) return json({ items: [] });
    const { data, error } = await db.from("food_products").select("*").in("code", codes).eq("status", "ok");
    if (error) return fail("db", 500);
    if (data && data.length) return json({ items: data.map(pub) });
    // в базе нет — сервер сам спрашивает Open Food Facts и запоминает ответ для всех
    for (const c of codes.slice(0, 3)) {
      const row = await offByCode(c);
      if (row) { await db.from("food_products").upsert(row, { onConflict: "code" }); return json({ items: [pub(row)], fetched: true }); }
    }
    return json({ items: [] });
  }

  if (act === "search") {
    const q = String(b.q ?? "").trim().slice(0, 40);
    if (q.length < 2) return json({ items: [] });
    const { data, error } = await db.from("food_products").select("*").eq("status", "ok")
      .or(`name.ilike.%${esc(q)}%,brand.ilike.%${esc(q)}%`).order("conf", { ascending: false }).limit(15);
    if (error) return fail("db", 500);
    return json({ items: (data ?? []).map(pub) });
  }

  if (act === "contribute") {
    const uid = await sessionUser(b.token); if (!uid) return fail("Сессия недействительна", 401);
    const code = String(b.code ?? ""); if (!/^[0-9]{6,14}$/.test(code)) return fail("code");
    const since = new Date(Date.now() - 864e5).toISOString();
    const { count } = await db.from("food_products").select("code", { count: "exact", head: true }).eq("added_by", uid).gte("created_at", since);
    if ((count ?? 0) >= DAY_LIMIT) return fail("limit", 429);
    const { data: ex } = await db.from("food_products").select("*").eq("code", code).maybeSingle();
    if (ex && ex.src === "off") return json({ ok: true, existed: true });            // OFF главнее любых правок
    const off = await offByCode(code);                                                // клиенту про «off» не верим — проверяем сами
    if (off) { await db.from("food_products").upsert({ ...off, added_by: uid }, { onConflict: "code" }); return json({ ok: true, verified: true }); }

    const name = String(b.name ?? "").replace(/\s+/g, " ").trim().slice(0, 90); if (name.length < 2) return fail("name");
    const brand = String(b.brand ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const k = n1(b.k, 0, 950), p = n1(b.p, 0, 100), f = n1(b.f, 0, 100), c = n1(b.c, 0, 100);
    if (k === null || p === null || f === null || c === null || p + f + c > 105) return fail("values");
    if (k > 0 && Math.abs(k - (p * 4 + c * 4 + f * 9)) > Math.max(60, k * 0.45)) return fail("kcal-mismatch");
    const u = b.u === "мл" ? "мл" : "г";
    if (!ex) {
      const { error } = await db.from("food_products").insert({ code, name, brand, k, p, f, c, u, src: "user", status: "pending", confirmers: [uid], added_by: uid });
      return error ? fail("db", 500) : json({ ok: true, pending: true });
    }
    if (ex.status === "pending" && !(ex.confirmers ?? []).includes(uid)) {
      const close = Math.abs(+ex.k - k) <= Math.max(15, k * 0.15);
      if (close && same(ex.name, name)) {
        const conf = [...(ex.confirmers ?? []), uid];
        await db.from("food_products").update({ confirmers: conf, status: conf.length >= 2 ? "ok" : "pending", conf: conf.length, updated_at: new Date().toISOString() }).eq("code", code);
        return json({ ok: true, confirmed: conf.length >= 2 });
      }
    }
    return json({ ok: true, existed: true });
  }

  if (act === "seed") {                                                               // импорт OFF; auto — по курсору из food_admin (вызывается pg_cron каждые 2 мин)
    const { data: key } = await db.from("food_admin").select("v").eq("k", "seed").maybeSingle();
    if (!key || !b.key || String(b.key) !== key.v) return fail("forbidden", 403);
    const PLAN: [string, number][] = [["kazakhstan", 999], ["russia", 150]];            // страны и максимум страниц (популярные идут первыми)
    const { data: cur } = await db.from("food_admin").select("v").eq("k", "cursor").maybeSingle();
    let [ci, pg] = String(cur?.v ?? "0:1").split(":").map(Number);
    if (ci >= PLAN.length) return json({ done: true });
    let seen = 0, saved = 0, pages = 0;
    const t0 = Date.now();
    while (ci < PLAN.length && Date.now() - t0 < 100000) {
      const [country, maxPg] = PLAN[ci];
      const j = await offFetch(`https://world.openfoodfacts.org/api/v2/search?countries_tags_en=${country}&fields=${FIELDS}&page_size=100&page=${pg}&sort_by=unique_scans_n`, 25000);
      if (!j) { await sleep(8000); if (Date.now() - t0 > 60000) break; continue; }     // OFF притормаживает — повторим эту же страницу
      const prods = j.products ?? [];
      const rows = prods.map((p: any) => offRow(p)).filter(Boolean);
      seen += prods.length; pages++;
      if (rows.length) { const { error } = await db.from("food_products").upsert(rows, { onConflict: "code" }); if (!error) saved += rows.length; }
      if (!prods.length || pg >= maxPg) { ci++; pg = 1; } else pg++;
      await db.from("food_admin").upsert({ k: "cursor", v: `${ci}:${pg}` });
      await sleep(6500);
    }
    return json({ cursor: `${ci}:${pg}`, pages, seen, saved });
  }
  return fail("act");
});
