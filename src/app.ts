/** The site: routing, admission, headers and the JSON API. src/worker.ts is the Workers entry. */
import { COMMIT } from "./build-info.ts";
import { edgeCache, type ProductCache, ttlFor } from "./cache.ts";
import type { Ctx, Env } from "./cf.ts";
import { canonicalEan } from "./data/ean.ts";
import { type DataEnv, getProduct, type Lookup, search, sized } from "./data/product.ts";
import { allergens, describe, diets } from "./describe.ts";
import { analyse, type AnalysisResult, kb } from "./engine.ts";
import { ENGINE_REPO, type Html, REPO } from "./html.ts";
import * as P from "./pages.ts";
import {
  anthropicReader,
  type BudgetStore,
  d1Budget,
  day,
  MAX_BODY,
  type PhotoError,
  type Reader,
  readPhotos,
  UUID_RE,
} from "./photo.ts";
import { RULES, type Score, score } from "./score.ts";

export const MAX_TEXT = 5000;
const MAX_FORM = 16 * 1024;

export const CSP = [
  "default-src 'self'",
  "img-src 'self' https://images.openfoodfacts.org blob: data:",
  "style-src 'self'",
  "font-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

const BASE_HEADERS: Record<string, string> = {
  "x-robots-tag": "noindex, nofollow",
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const htmlRes = (h: Html, status = 200, cache = "public, max-age=300", extra: Record<string, string> = {}) =>
  new Response(h.value, {
    status,
    headers: {
      ...BASE_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "cache-control": cache,
      ...extra,
    },
  });
const jsonRes = (v: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(v), {
    status,
    headers: {
      ...BASE_HEADERS,
      ...CORS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": cache,
    },
  });
const redirect = (to: string, status = 302, cache?: string) =>
  new Response(null, {
    status,
    headers: { ...BASE_HEADERS, location: to, ...(cache ? { "cache-control": cache } : {}) },
  });

/** Shown wherever a product has no photo (static asset). */
export const PLACEHOLDER = "/pack.svg";

/** Rate-limit key: the IPv4 address, or the /64 of an IPv6 one (one household or phone holds a whole /64). */
export function ipKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = tail === undefined
    ? h
    : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

export interface Deps {
  fetch?: typeof fetch;
  cache?: ProductCache | null;
  reader?: (env: Env) => Reader | null;
  budget?: (env: Env) => BudgetStore | null;
  now?: () => Date;
  uuid?: () => string;
}

const defaultReader = (env: Env) =>
  env.ANTHROPIC_API_KEY
    ? anthropicReader(env.ANTHROPIC_API_KEY, env.PHOTO_MODEL || "claude-haiku-5-5")
    : null;
const defaultBudget = (env: Env) => (env.DB ? d1Budget(env.DB) : null);
const defaultCache = (): ProductCache | null => {
  const c = (globalThis as { caches?: { default?: Cache } }).caches;
  return c?.default ? edgeCache(c.default) : null;
};

function meta(extra: Record<string, unknown> = {}) {
  return {
    powered_by: `ns-ingredients (NextSolutions) ${ENGINE_REPO}`,
    rules: `v${RULES.version} (${RULES.status}), CC BY-SA 4.0`,
    kb_version: kb().version,
    data: "Open Food Facts, ODbL 1.0 (via ns-food or directly)",
    source_code: `${REPO}/tree/${COMMIT === "unknown" ? "main" : COMMIT}`,
    disclaimer: "Ocena składu z etykiety, nie porada medyczna.",
    ...extra,
  };
}

function rated(text: string): { a: AnalysisResult; s: Score } {
  const a = analyse(text);
  return { a, s: score(a, text) };
}

const analysisJson = (a: AnalysisResult, s: Score) => ({
  score: s,
  description: describe(a, s),
  allergens: allergens(a),
  diets: diets(a),
  analysis: a,
});

export function makeHandler(deps: Deps = {}) {
  const now = deps.now ?? (() => new Date());
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  let cache: ProductCache | null | undefined = deps.cache;

  async function lookup(env: Env, ctx: Ctx, ean: string): Promise<Lookup> {
    cache ??= defaultCache();
    const hit = await cache?.get(ean).catch(() => null);
    if (hit) return hit;
    const data: DataEnv = {
      NS_FOOD_URL: env.NS_FOOD_URL,
      NS_FOOD_KEY: env.NS_FOOD_KEY,
      fetch: deps.fetch,
      now,
    };
    const l = await getProduct(data, ean);
    const ttl = ttlFor(l);
    if (cache && ttl) ctx.waitUntil(cache.put(ean, l, ttl).catch(() => {}));
    return l;
  }

  const cap = (env: Env) => Number(env.PHOTO_DAILY_CAP) || 300;
  const photoError = (env: Env, error: PhotoError, status: number, ean?: string) =>
    htmlRes(P.photoPage({ requestId: uuid(), ean, error, cap: cap(env) }), status, "no-store");

  async function photoPost(req: Request, env: Env, ip: string): Promise<Response> {
    if (env.PHOTO_LIMIT && !(await env.PHOTO_LIMIT.limit({ key: ip })).success) {
      return photoError(env, "rate_limited", 429);
    }
    const len = Number(req.headers.get("content-length") ?? NaN);
    if (!Number.isFinite(len)) return photoError(env, "bad_request", 411);
    if (len > MAX_BODY) return photoError(env, "too_large", 413);
    const reader = (deps.reader ?? defaultReader)(env);
    const budget = (deps.budget ?? defaultBudget)(env);
    if (!reader || !budget) return photoError(env, "not_configured", 503);
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return photoError(env, "bad_request", 400);
    }
    const id = String(form.get("request_id") ?? "");
    const ean = canonicalEan(String(form.get("ean") ?? "")) ?? undefined;
    if (!UUID_RE.test(id)) return photoError(env, "bad_request", 400, ean);
    const files = form.getAll("photo").filter((f): f is File => f instanceof File && f.size > 0);
    const read = await readPhotos(files);
    if (!read.ok) return photoError(env, read.error, 400, ean);
    const d = day(now());
    try {
      if (!(await budget.claim(id, d))) return photoError(env, "duplicate", 409, ean);
      if ((await budget.take(d, read.photos.length, cap(env))) === null) {
        return photoError(env, "daily_cap", 429, ean);
      }
    } catch {
      // Fail closed: without a working budget nothing is sent to the model.
      return photoError(env, "not_configured", 503, ean);
    }
    const r = await reader.read(read.photos);
    if (!r.ok) return photoError(env, r.error, r.error === "rate_limited" ? 429 : 422, ean);
    const fromPhoto = canonicalEan(r.label.ean);
    return htmlRes(P.confirmPage(r.label, fromPhoto, ean ?? ""), 200, "no-store");
  }

  async function ratePost(req: Request): Promise<Response> {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_FORM) {
      return htmlRes(P.errorPage(), 413, "no-store");
    }
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return redirect("/zdjecie", 303);
    }
    const text = String(form.get("ingredients") ?? "").trim();
    if (!text) return redirect("/zdjecie", 303);
    if (text.length > MAX_TEXT) return htmlRes(P.errorPage(), 413, "no-store");
    const may = String(form.get("may_contain") ?? "").trim().slice(0, 500);
    const full = may ? `${text}\nMoże zawierać: ${may}` : text;
    const { a, s } = rated(full);
    const name = String(form.get("name") ?? "").trim().slice(0, 120);
    const from = form.get("from") === "photo" ? "photo" : "text";
    return htmlRes(P.ratedPage({ name, text: full, from }, a, s), 200, "no-store");
  }

  async function analyzeApi(req: Request): Promise<Response> {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_FORM) {
      return jsonRes({ ok: false, error: "too_large" }, 413);
    }
    let body: { text?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonRes({ ok: false, error: "bad_request", message: 'Send JSON: {"text": "…"}' }, 400);
    }
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return jsonRes({ ok: false, error: "bad_request", message: "text is required" }, 400);
    if (text.length > MAX_TEXT) {
      return jsonRes({ ok: false, error: "too_large", message: `text over ${MAX_TEXT} characters` }, 413);
    }
    const { a, s } = rated(text);
    return jsonRes({ ok: true, data: analysisJson(a, s), meta: meta() });
  }

  async function productApi(env: Env, ctx: Ctx, raw: string): Promise<Response> {
    const ean = canonicalEan(raw);
    if (!ean) return jsonRes({ ok: false, error: "invalid_ean" }, 400);
    const l = await lookup(env, ctx, ean);
    if (l.status === "not_found") {
      return jsonRes({ ok: false, error: "not_found", meta: meta({ fell_back: l.fellBack }) }, 404);
    }
    if (l.status === "unavailable") {
      return jsonRes(
        { ok: false, error: "unavailable", message: "ns-food and Open Food Facts both failed" },
        503,
      );
    }
    if (l.status !== "found") return jsonRes({ ok: false, error: "invalid_ean" }, 400);
    const r = l.product.ingredientsText ? rated(l.product.ingredientsText) : null;
    return jsonRes(
      {
        ok: true,
        data: {
          product: l.product,
          ...(r ? analysisJson(r.a, r.s) : { score: null, description: [], analysis: null }),
        },
        meta: meta({ source: l.product.source, fell_back: l.fellBack, fetched_at: l.product.fetchedAt }),
      },
      200,
      "public, max-age=300",
    );
  }

  /**
   * A product's photo for search thumbnails: ns-food's search answer carries no image, so each thumbnail looks the
   * product up (the same cache and the same ns-food-then-OFF path as its page) and is redirected to OFF's 200 px
   * photo. No photo, an invalid code, an exhausted allowance or a failed lookup all give the placeholder, so a
   * thumbnail never shows a broken image.
   */
  async function image(env: Env, ctx: Ctx, raw: string, ip: string): Promise<Response> {
    const none = (cache: string) => redirect(PLACEHOLDER, 302, cache);
    const ean = canonicalEan(raw);
    if (!ean) return none("public, max-age=86400");
    if (env.IMG_LIMIT && !(await env.IMG_LIMIT.limit({ key: ip })).success) return none("no-store");
    const l = await lookup(env, ctx, ean).catch(() => null);
    if (l?.status === "found" && l.product.imageUrl) {
      return redirect(sized(l.product.imageUrl, 200), 302, "public, max-age=86400");
    }
    return none(l?.status === "found" || l?.status === "not_found" ? "public, max-age=3600" : "no-store");
  }

  async function productPage(env: Env, ctx: Ctx, raw: string): Promise<Response> {
    const ean = canonicalEan(raw);
    if (!ean) return htmlRes(P.notFoundPage("invalid", raw.slice(0, 40)), 404);
    if (ean !== raw) return redirect(`/p/${ean}`, 301);
    const l = await lookup(env, ctx, ean);
    if (l.status === "not_found") return htmlRes(P.notFoundPage("product", ean), 404, "public, max-age=300");
    if (l.status === "unavailable") {
      return htmlRes(P.unavailablePage(ean), 503, "no-store", { "retry-after": "30" });
    }
    if (l.status !== "found") return htmlRes(P.notFoundPage("invalid", ean), 404);
    const r = l.product.ingredientsText ? rated(l.product.ingredientsText) : null;
    return htmlRes(P.productPage(l, r?.a ?? null, r?.s ?? null));
  }

  async function route(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "/";
    const ip = ipKey(req.headers.get("cf-connecting-ip") ?? "local");
    const api = path.startsWith("/api/");
    if (api && req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...BASE_HEADERS, ...CORS } });
    }
    const param = (re: RegExp) => {
      const m = path.match(re);
      if (!m) return null;
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return "";
      }
    };
    // Thumbnails have their own, larger allowance: one search page asks for up to 20 of them at once.
    const img = param(/^\/img\/([^/]+)$/);
    if (img !== null && (req.method === "GET" || req.method === "HEAD")) {
      return await image(env, ctx, img, ip);
    }
    if (env.PAGE_LIMIT && !(await env.PAGE_LIMIT.limit({ key: ip })).success) {
      return api
        ? jsonRes({ ok: false, error: "rate_limited" }, 429)
        : htmlRes(P.tooManyPage(), 429, "no-store", { "retry-after": "10" });
    }
    const get = req.method === "GET" || req.method === "HEAD";

    if (req.method === "POST") {
      if (path === "/zdjecie") return await photoPost(req, env, ip);
      if (path === "/ocen") return await ratePost(req);
      if (path === "/api/analyze") return await analyzeApi(req);
      return htmlRes(P.notFoundPage("page"), 405, "no-store", { allow: "GET, HEAD" });
    }
    if (!get) {
      return new Response(null, { status: 405, headers: { ...BASE_HEADERS, allow: "GET, HEAD, POST" } });
    }

    if (path === "/") return htmlRes(P.homePage(), 200, "public, max-age=3600");
    if (path === "/szukaj") {
      const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
      const ean = canonicalEan(q);
      if (ean) return redirect(`/p/${ean}`);
      if (q.length < 2) return redirect("/");
      const r = await search({
        NS_FOOD_URL: env.NS_FOOD_URL,
        NS_FOOD_KEY: env.NS_FOOD_KEY,
        fetch: deps.fetch,
      }, q);
      return htmlRes(P.searchPage(q, r), 200, r.why ? "no-store" : "public, max-age=300");
    }
    let p = param(/^\/p\/([^/]+)$/);
    if (p !== null) return await productPage(env, ctx, p);
    p = param(/^\/api\/product\/([^/]+)$/);
    if (p !== null) return await productApi(env, ctx, p);
    p = param(/^\/skladnik\/([^/]+)$/);
    if (p !== null) {
      const h = p ? P.ingredientPage(p) : null;
      return h ? htmlRes(h, 200, "public, max-age=3600") : htmlRes(P.notFoundPage("ingredient"), 404);
    }
    if (path === "/zdjecie") {
      const ean = canonicalEan(url.searchParams.get("ean") ?? "") ?? undefined;
      return htmlRes(P.photoPage({ requestId: uuid(), ean, cap: cap(env) }), 200, "no-store");
    }
    if (path === "/jak-liczymy") return htmlRes(P.methodPage(), 200, "public, max-age=3600");
    if (path === "/o-danych") return htmlRes(P.dataPage(), 200, "public, max-age=3600");
    if (path === "/api/analyze") {
      return jsonRes({ ok: false, error: "method", message: 'POST {"text": "…"}' }, 405);
    }
    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(req);
      if (asset.status !== 404) return asset;
    }
    return api ? jsonRes({ ok: false, error: "not_found" }, 404) : htmlRes(P.notFoundPage("page"), 404);
  }

  return async function handle(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      // Names only: request bodies (photos, typed labels) are never logged.
      console.error("unhandled", e instanceof Error ? e.name : typeof e);
      return htmlRes(P.errorPage(), 500, "no-store");
    }
  };
}
