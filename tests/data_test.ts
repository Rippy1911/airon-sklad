import { assert, assertEquals } from "@std/assert";
import { ttlFor } from "../src/cache.ts";
import { canonicalEan } from "../src/data/ean.ts";
import { fromNsFood, getProduct, safeImage, search } from "../src/data/product.ts";
import { fakeFetch, hang, json, NS, nsProduct, OFF, offProduct } from "./helpers.ts";

const EAN = "4006381333931";
const env = (fetch: typeof globalThis.fetch, key = "k") => ({
  NS_FOOD_URL: `https://${NS}`,
  NS_FOOD_KEY: key,
  fetch,
  timeoutMs: 30,
});

Deno.test("canonical EAN: check digit, lengths, UPC-A and GTIN-14", () => {
  assertEquals(canonicalEan("4006381333931"), "4006381333931");
  assertEquals(canonicalEan("400 6381 333931"), "4006381333931");
  assertEquals(canonicalEan("4006381333932"), null);
  assertEquals(canonicalEan("96385074"), "96385074");
  assertEquals(canonicalEan("036000291452"), "0036000291452");
  assertEquals(canonicalEan("04006381333931"), "4006381333931");
  assertEquals(canonicalEan("123"), null);
  assertEquals(canonicalEan("abc4006381333931"), null);
});

Deno.test("invalid EAN never reaches an upstream", async () => {
  const f = fakeFetch({});
  assertEquals(await getProduct(env(f.fetch), "4006381333932"), { status: "invalid" });
  assertEquals(f.calls.length, 0);
});

Deno.test("ns-food answer is used as is, no OFF call", async () => {
  const f = fakeFetch({ [NS]: (u) => (assertEquals(u.pathname, `/v1/product/${EAN}`), json(nsProduct())) });
  const l = await getProduct(env(f.fetch), EAN);
  assert(l.status === "found");
  assertEquals([l.product.source, l.fellBack, l.product.name, l.product.quantity], [
    "ns-food",
    false,
    "Biszkopty testowe",
    "140 g",
  ]);
  assertEquals(f.calls.length, 1);
  assertEquals(ttlFor(l), 21600);
});

const fallbacks: [string, Parameters<typeof fakeFetch>[0][string], string][] = [
  [
    "200 with data null (ns-food's miss)",
    () => json({ ok: true, data: null, meta: { found: false } }),
    "not in ns-food",
  ],
  ["404", () => json({ ok: false }, 404), "not in ns-food"],
  ["429 rate limit", () => json({ ok: false, error: "rate_limited" }, 429), "ns-food HTTP 429"],
  ["500", () => new Response("boom", { status: 500 }), "ns-food HTTP 500"],
  ["401 (a config failure, still answered from OFF)", () => json({ ok: false }, 401), "ns-food HTTP 401"],
  ["timeout", hang, "ns-food timeout"],
  ["network error", () => Promise.reject(new TypeError("connection refused")), "ns-food unreachable"],
];
for (const [name, ns, why] of fallbacks) {
  Deno.test(`falls back to Open Food Facts on ns-food ${name}`, async () => {
    const f = fakeFetch({ [NS]: ns, [OFF]: () => json(offProduct()) });
    const l = await getProduct(env(f.fetch), EAN);
    assert(l.status === "found");
    assertEquals([l.product.source, l.fellBack, l.why], ["off", true, why]);
    assertEquals(l.product.name, "Biszkopty z OFF");
    assertEquals(l.product.brand, "Testowa");
    assertEquals(l.product.imageUrl, null, "non-OFF image host dropped");
    assertEquals(l.product.offModified, "2026-01-01");
    assertEquals(l.product.nutrients.fat, null, "missing nutrient stays null");
    assertEquals(ttlFor(l), why === "not in ns-food" ? 21600 : 1800);
  });
}

Deno.test("no ns-food key configured: straight to OFF", async () => {
  const f = fakeFetch({ [OFF]: () => json(offProduct()) });
  const l = await getProduct(env(f.fetch, ""), EAN);
  assert(l.status === "found" && l.fellBack);
});

Deno.test("both definitively miss: not_found, cached for an hour", async () => {
  const f = fakeFetch({ [NS]: () => json({ ok: true, data: null }), [OFF]: () => json({ status: 0 }) });
  const l = await getProduct(env(f.fetch), EAN);
  assertEquals(l, { status: "not_found", fellBack: true, why: "not in ns-food" });
  assertEquals(ttlFor(l), 3600);
});

Deno.test("ns-food down and OFF misses: not_found, never cached", async () => {
  const f = fakeFetch({ [NS]: () => new Response("", { status: 503 }), [OFF]: () => json({ status: 0 }) });
  const l = await getProduct(env(f.fetch), EAN);
  assertEquals(l.status, "not_found");
  assertEquals(ttlFor(l), null);
});

Deno.test("both fail: unavailable, never cached", async () => {
  const f = fakeFetch({ [NS]: () => new Response("", { status: 500 }), [OFF]: hang });
  const l = await getProduct(env(f.fetch), EAN);
  assertEquals(l, { status: "unavailable", why: "ns-food HTTP 500; OFF timeout" });
  assertEquals(ttlFor(l), null);
});

Deno.test("ns-food zeros are flagged as maybe-missing", () => {
  const p = fromNsFood(nsProduct().data, EAN, "2026-11-15T00:00:00Z");
  assertEquals(p.nutrients.fiber, 0);
  assert(p.zeroMayBeMissing);
});

Deno.test("only OFF's image host is kept", () => {
  assertEquals(safeImage("https://images.openfoodfacts.org/a.jpg"), "https://images.openfoodfacts.org/a.jpg");
  assertEquals(safeImage("http://images.openfoodfacts.org/a.jpg"), null);
  assertEquals(safeImage("https://images.openfoodfacts.org.evil.example/a.jpg"), null);
  assertEquals(safeImage("javascript:alert(1)"), null);
});

Deno.test("search uses ns-food autocomplete, falls back to OFF when it has nothing", async () => {
  const hit = { name: "Biszkopty", brand: "T", barcode: EAN };
  const ok = fakeFetch({
    [NS]: (
      u,
    ) => (assertEquals(u.pathname, "/v1/autocomplete"),
      json({ ok: true, data: [hit, { name: "zły kod", barcode: "1" }] })),
  });
  const r = await search(env(ok.fetch), "biszkopty");
  assertEquals([r.source, r.hits.length, r.hits[0].ean], ["ns-food", 1, EAN]);

  const empty = fakeFetch({
    [NS]: () => json({ ok: true, data: [] }),
    "search.openfoodfacts.org": () =>
      json({ hits: [{ code: EAN, product_name_pl: "Z OFF", brands: ["Marka"] }] }),
  });
  const r2 = await search(env(empty.fetch), "biszkopty");
  assertEquals([r2.source, r2.hits[0].name, r2.hits[0].brand], ["off", "Z OFF", "Marka"]);
});

Deno.test("sized swaps only OFF's size suffix", async () => {
  const { sized } = await import("../src/data/product.ts");
  const base = "https://images.openfoodfacts.org/images/products/590/067/200/1082/front_pl.22";
  assertEquals(sized(`${base}.400.jpg`, 200), `${base}.200.jpg`);
  assertEquals(sized(`${base}.full.jpg`, 400), `${base}.400.jpg`);
  assertEquals(
    sized("https://images.openfoodfacts.org/x/other.png", 200),
    "https://images.openfoodfacts.org/x/other.png",
  );
});
