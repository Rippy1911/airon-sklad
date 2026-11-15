/**
 * Product data: ns-food first; Open Food Facts when ns-food is rate-limited, down, slow, or does not have the code
 * (its curation drops OFF rows without a calorie value, which may still carry an ingredient list).
 * Everything read here is untrusted crowd data: it is only ever rendered through the escaping template.
 */
import { canonicalEan } from "./ean.ts";

export type Source = "ns-food" | "off";

export interface Nutrients {
  kcal: number | null;
  fat: number | null;
  satfat: number | null;
  carbs: number | null;
  sugars: number | null;
  fiber: number | null;
  protein: number | null;
  salt: number | null;
}

export interface Product {
  ean: string;
  name: string;
  brand: string;
  quantity: string;
  ingredientsText: string;
  allergenTags: string[];
  tracesTags: string[];
  labelTags: string[];
  nutrients: Nutrients;
  /** True when a 0 may mean "missing": ns-food stores an absent nutrient as 0. */
  zeroMayBeMissing: boolean;
  imageUrl: string | null;
  categories: string;
  /** When OFF last changed the product, if the source says. */
  offModified: string | null;
  source: Source;
  fetchedAt: string;
}

export type Lookup =
  | { status: "found"; product: Product; fellBack: boolean; why?: string }
  | { status: "not_found"; fellBack: boolean; why?: string }
  | { status: "invalid" }
  | { status: "unavailable"; why: string };

export interface DataEnv {
  NS_FOOD_URL: string;
  NS_FOOD_KEY?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export const OFF_UA = "airon-sklad/0.1 (+https://github.com/Rippy1911/airon-sklad)";
const OFF_FIELDS = [
  "code",
  "product_name_pl",
  "product_name",
  "brands",
  "quantity",
  "ingredients_text_pl",
  "ingredients_text",
  "allergens_tags",
  "traces_tags",
  "labels_tags",
  "nutriments",
  "image_front_url",
  "categories",
  "last_modified_t",
].join(",");

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strs = (
  v: unknown,
): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Only OFF's own image host is shown; anything else is dropped (CSP allows that host only). */
export function safeImage(url: unknown): string | null {
  const s = str(url);
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname === "images.openfoodfacts.org" ? u.href : null;
  } catch {
    return null;
  }
}

export function fromNsFood(d: Record<string, unknown>, ean: string, fetchedAt: string): Product {
  const extra = (d.extra && typeof d.extra === "object" ? d.extra : {}) as Record<string, unknown>;
  const pkg = num(d.package_grams ?? extra.package_grams);
  return {
    ean,
    name: str(d.name),
    brand: str(d.brand),
    quantity: pkg ? `${pkg} g` : "",
    ingredientsText: str(d.ingredients_text ?? extra.ingredients_text),
    allergenTags: strs(d.allergens_tags ?? extra.allergens_tags),
    tracesTags: [],
    labelTags: [],
    nutrients: {
      kcal: num(d.calories_per_100g),
      fat: num(d.fat_per_100g),
      satfat: num(d.saturated_fat_per_100g),
      carbs: num(d.carbs_per_100g),
      sugars: num(d.sugars_per_100g),
      fiber: num(d.fiber_per_100g),
      protein: num(d.protein_per_100g),
      salt: num(d.salt_per_100g),
    },
    zeroMayBeMissing: true,
    imageUrl: safeImage(d.image_url),
    categories: str(d.categories),
    offModified: null,
    source: "ns-food",
    fetchedAt,
  };
}

export function fromOff(p: Record<string, unknown>, ean: string, fetchedAt: string): Product {
  const n = (p.nutriments && typeof p.nutriments === "object" ? p.nutriments : {}) as Record<string, unknown>;
  const t = num(p.last_modified_t);
  return {
    ean,
    name: str(p.product_name_pl) || str(p.product_name),
    brand: str(p.brands).split(",")[0]?.trim() ?? "",
    quantity: str(p.quantity),
    ingredientsText: str(p.ingredients_text_pl) || str(p.ingredients_text),
    allergenTags: strs(p.allergens_tags),
    tracesTags: strs(p.traces_tags),
    labelTags: strs(p.labels_tags),
    nutrients: {
      kcal: num(n["energy-kcal_100g"]),
      fat: num(n.fat_100g),
      satfat: num(n["saturated-fat_100g"]),
      carbs: num(n.carbohydrates_100g),
      sugars: num(n.sugars_100g),
      fiber: num(n.fiber_100g),
      protein: num(n.proteins_100g),
      salt: num(n.salt_100g),
    },
    zeroMayBeMissing: false,
    imageUrl: safeImage(p.image_front_url),
    categories: str(p.categories),
    offModified: t ? new Date(t * 1000).toISOString().slice(0, 10) : null,
    source: "off",
    fetchedAt,
  };
}

type Upstream =
  | { kind: "found"; data: Record<string, unknown> }
  | { kind: "missing" }
  | { kind: "failed"; why: string };

async function timed(env: DataEnv, url: string, init: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), env.timeoutMs ?? 2500);
  try {
    return await (env.fetch ?? fetch)(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** ns-food's full lookup (cache, then its own live OFF read). Plain route: `web=never` would answer from cache only. */
export async function nsFoodProduct(env: DataEnv, ean: string): Promise<Upstream> {
  if (!env.NS_FOOD_KEY) return { kind: "failed", why: "ns-food key not configured" };
  try {
    const res = await timed(env, `${env.NS_FOOD_URL}/v1/product/${ean}?locale=pl`, {
      headers: { authorization: `Bearer ${env.NS_FOOD_KEY}` },
    });
    if (res.status === 404) return { kind: "missing" };
    if (!res.ok) return { kind: "failed", why: `ns-food HTTP ${res.status}` };
    const body = await res.json() as {
      ok?: boolean;
      data?: Record<string, unknown> | null;
      meta?: { found?: boolean };
    };
    const d = body?.data;
    if (!body?.ok || !d || typeof d !== "object" || body.meta?.found === false || !str(d.name)) {
      return { kind: "missing" };
    }
    return { kind: "found", data: d };
  } catch (e) {
    return {
      kind: "failed",
      why: e instanceof DOMException && e.name === "AbortError" ? "ns-food timeout" : "ns-food unreachable",
    };
  }
}

export async function offProduct(env: DataEnv, ean: string): Promise<Upstream> {
  try {
    const res = await timed(
      env,
      `https://world.openfoodfacts.org/api/v2/product/${ean}?fields=${OFF_FIELDS}`,
      {
        headers: { "user-agent": OFF_UA },
      },
    );
    if (res.status === 404) return { kind: "missing" };
    if (!res.ok) return { kind: "failed", why: `OFF HTTP ${res.status}` };
    const body = await res.json() as { status?: number; product?: Record<string, unknown> };
    if (body?.status !== 1 || !body.product) return { kind: "missing" };
    return { kind: "found", data: body.product };
  } catch (e) {
    return {
      kind: "failed",
      why: e instanceof DOMException && e.name === "AbortError" ? "OFF timeout" : "OFF unreachable",
    };
  }
}

export async function getProduct(env: DataEnv, input: string): Promise<Lookup> {
  const ean = canonicalEan(input);
  if (!ean) return { status: "invalid" };
  const at = (env.now?.() ?? new Date()).toISOString();
  const ns = await nsFoodProduct(env, ean);
  if (ns.kind === "found") return { status: "found", product: fromNsFood(ns.data, ean, at), fellBack: false };
  const why = ns.kind === "failed" ? ns.why : "not in ns-food";
  const off = await offProduct(env, ean);
  if (off.kind === "found") {
    return { status: "found", product: fromOff(off.data, ean, at), fellBack: true, why };
  }
  if (off.kind === "missing") return { status: "not_found", fellBack: true, why };
  // Both failed: say so rather than "not found".
  return ns.kind === "missing"
    ? { status: "unavailable", why: off.why }
    : { status: "unavailable", why: `${why}; ${off.why}` };
}

export interface SearchHit {
  ean: string;
  name: string;
  brand: string;
  imageUrl: string | null;
}

/**
 * ns-food's autocomplete (catalogue only: unlike /v1/search it never queues a background lookup per query), then
 * Open Food Facts search when ns-food fails or has nothing (its catalogue answers [] while it is down, too).
 */
export async function search(
  env: DataEnv,
  q: string,
): Promise<{ hits: SearchHit[]; source: Source | null; why?: string }> {
  const query = q.trim().slice(0, 80);
  if (query.length < 2) return { hits: [], source: null };
  if (env.NS_FOOD_KEY) {
    try {
      const u = `${env.NS_FOOD_URL}/v1/autocomplete?q=${encodeURIComponent(query)}&locale=pl&limit=20`;
      const res = await timed(env, u, { headers: { authorization: `Bearer ${env.NS_FOOD_KEY}` } });
      if (res.ok) {
        const body = await res.json() as { data?: Record<string, unknown>[] };
        const hits = (body.data ?? [])
          .map((d) => ({
            ean: canonicalEan(str(d.barcode)) ?? "",
            name: str(d.name),
            brand: str(d.brand),
            imageUrl: null,
          }))
          .filter((h) => h.ean && h.name);
        if (hits.length) return { hits, source: "ns-food" };
      }
    } catch { /* fall through to OFF */ }
  }
  try {
    const u = `https://search.openfoodfacts.org/search?q=${
      encodeURIComponent(query)
    }&page_size=20&fields=code,product_name,product_name_pl,brands,image_front_url`;
    const res = await timed(env, u, { headers: { "user-agent": OFF_UA } });
    if (!res.ok) return { hits: [], source: null, why: `OFF HTTP ${res.status}` };
    const body = await res.json() as { hits?: Record<string, unknown>[] };
    const hits = (body.hits ?? [])
      .map((h) => ({
        ean: canonicalEan(str(h.code)) ?? "",
        name: str(h.product_name_pl) || str(h.product_name),
        brand: (Array.isArray(h.brands) ? str(h.brands[0]) : str(h.brands).split(",")[0] ?? "").trim(),
        imageUrl: safeImage(h.image_front_url),
      }))
      .filter((h) => h.ean && h.name);
    return { hits, source: "off" };
  } catch {
    return { hits: [], source: null, why: "search unavailable" };
  }
}
