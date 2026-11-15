import { DatabaseSync } from "node:sqlite";
import type { Ctx, D1Like, D1Stmt } from "../src/cf.ts";

/** D1's prepare/bind/first/run over a real in-memory SQLite, with the repo's migrations applied. */
export async function sqliteD1(): Promise<D1Like & { db: DatabaseSync; fail?: boolean }> {
  const db = new DatabaseSync(":memory:");
  for (const f of [...Deno.readDirSync("migrations")].map((e) => e.name).sort()) {
    db.exec(await Deno.readTextFile(`migrations/${f}`));
  }
  const self: D1Like & { db: DatabaseSync; fail?: boolean } = {
    db,
    prepare(sql: string): D1Stmt {
      let args: unknown[] = [];
      const stmt: D1Stmt = {
        bind(...v) {
          args = v;
          return stmt;
        },
        first<T>() {
          if (self.fail) return Promise.reject(new Error("D1 down"));
          return Promise.resolve((db.prepare(sql).get(...(args as never[])) ?? null) as T | null);
        },
        run() {
          if (self.fail) return Promise.reject(new Error("D1 down"));
          const r = db.prepare(sql).run(...(args as never[]));
          return Promise.resolve({ meta: { changes: Number(r.changes) } });
        },
      };
      return stmt;
    },
  };
  return self;
}

export const ctx = (): Ctx & { pending: Promise<unknown>[] } => {
  const pending: Promise<unknown>[] = [];
  return { pending, waitUntil: (p) => void pending.push(p) };
};

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** A fetch that answers by host, counting calls; an unrouted host is a test failure. */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.href);
    const h = routes[url.host];
    if (!h) throw new Error(`unexpected fetch ${url.href}`);
    return await h(url, init);
  }) as typeof fetch;
  return { fetch: f, calls };
}

/** Never answers until aborted, like an upstream that hangs. */
export const hang: Handler = (_u, init) =>
  new Promise((_, reject) =>
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
  );

export const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

export const NS = "food.test";
export const OFF = "world.openfoodfacts.org";

export const nsProduct = (over: Record<string, unknown> = {}) => ({
  ok: true,
  data: {
    barcode: "4006381333931",
    name: "Biszkopty testowe",
    brand: "Testowa",
    calories_per_100g: 377,
    protein_per_100g: 12,
    carbs_per_100g: 72,
    fat_per_100g: 4.1,
    fiber_per_100g: 0,
    sugars_per_100g: 39,
    saturated_fat_per_100g: 1.2,
    salt_per_100g: 0.3,
    image_url: "https://images.openfoodfacts.org/images/products/400/638/133/3931/front_pl.3.400.jpg",
    ingredients_text: "Mąka pszenna, cukier, jaja, sól, miód",
    allergens_tags: ["en:gluten", "en:eggs"],
    package_grams: 140,
    ...over,
  },
  meta: { source: "cache", cached: true },
});

export const offProduct = (over: Record<string, unknown> = {}) => ({
  status: 1,
  product: {
    code: "4006381333931",
    product_name_pl: "Biszkopty z OFF",
    brands: "Testowa,Inna",
    quantity: "140 g",
    ingredients_text_pl: "Mąka pszenna, jaja, sól",
    allergens_tags: ["en:gluten"],
    traces_tags: ["en:nuts"],
    nutriments: { "energy-kcal_100g": 350, sugars_100g: 2, salt_100g: 0.5 },
    image_front_url: "https://evil.example/x.jpg",
    last_modified_t: 1767225600,
    ...over,
  },
});
