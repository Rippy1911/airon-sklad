import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { memoryCache } from "../src/cache.ts";
import type { Env } from "../src/cf.ts";
import { esc, html } from "../src/html.ts";
import { d1Budget, type Reader } from "../src/photo.ts";
import { ipKey, makeHandler } from "../src/app.ts";
import { ctx, fakeFetch, json, NS, nsProduct, OFF, offProduct, sqliteD1 } from "./helpers.ts";

const EAN = "4006381333931";
const ENV: Env = { NS_FOOD_URL: `https://${NS}`, NS_FOOD_KEY: "k", PHOTO_DAILY_CAP: "5" };
const get = (path: string, init?: RequestInit) => new Request(`https://sklad.test${path}`, init);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const UUID = "123e4567-e89b-42d3-a456-426614174000";

function fakeReader(calls: { n: number }, over: Partial<Awaited<ReturnType<Reader["read"]>>> = {}): Reader {
  return {
    read(photos) {
      calls.n += photos.length;
      return Promise.resolve({
        ok: true,
        label: {
          legibility: "clear",
          product_name: "Biszkopty",
          brand: "Testowa",
          quantity: "",
          ean: EAN,
          ingredients_found: true,
          ingredients_text: "_Mąka pszenna_, cukier, <script>alert(1)</script>, sól",
          may_contain: "Może zawierać: sezam",
          nutrition_per_100g: {
            kcal: null,
            fat: null,
            satfat: null,
            carbs: null,
            sugars: null,
            fiber: null,
            protein: null,
            salt: null,
          },
          notes: "",
        },
        ...over,
      } as Awaited<ReturnType<Reader["read"]>>);
    },
  };
}

function photoForm(n = 1, id = UUID): FormData {
  const fd = new FormData();
  fd.set("request_id", id);
  for (let i = 0; i < n; i++) fd.append("photo", new File([JPEG], `p${i}.jpg`, { type: "image/jpeg" }));
  return fd;
}

async function postPhotos(h: ReturnType<typeof makeHandler>, fd: FormData, env: Env = ENV) {
  const req = new Request("https://sklad.test/zdjecie", { method: "POST", body: fd });
  // Request bodies built from FormData have no Content-Length until serialised; a browser always sends one.
  const body = new Uint8Array(await req.arrayBuffer());
  const sized = new Request("https://sklad.test/zdjecie", {
    method: "POST",
    body,
    headers: { "content-type": req.headers.get("content-type")!, "content-length": String(body.length) },
  });
  return await h(sized, env, ctx());
}

Deno.test("escaping: data can never become markup", () => {
  assertEquals(esc(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  const evil = `"><script>alert(1)</script>`;
  const out = html`<input value="${evil}"><p>${[evil, html`<b>ok</b>`]}</p>`.value;
  assert(!out.includes("<script>"));
  assertStringIncludes(out, "<b>ok</b>");
});

Deno.test("every Worker page is noindex with the strict CSP", async () => {
  const f = fakeFetch({ [NS]: () => json(nsProduct()) });
  const h = makeHandler({ fetch: f.fetch, cache: memoryCache() });
  for (
    const path of [
      "/",
      "/jak-liczymy",
      "/o-danych",
      "/zdjecie",
      `/p/${EAN}`,
      "/nie-ma",
      `/api/product/${EAN}`,
    ]
  ) {
    const r = await h(get(path), ENV, ctx());
    assertEquals(r.headers.get("x-robots-tag"), "noindex, nofollow", path);
    assertStringIncludes(r.headers.get("content-security-policy") ?? "", "script-src 'self'", path);
    assertStringIncludes(r.headers.get("content-security-policy") ?? "", "frame-ancestors 'none'", path);
  }
});

Deno.test("asset headers file and robots.txt keep the site crawlable but unindexed", async () => {
  assertStringIncludes(await Deno.readTextFile("public/_headers"), "X-Robots-Tag: noindex, nofollow");
  assertEquals((await Deno.readTextFile("public/robots.txt")).trim(), "User-agent: *\nAllow: /");
});

Deno.test("product page: ns-food data, score, credits and source link", async () => {
  const f = fakeFetch({ [NS]: () => json(nsProduct()) });
  const cache = memoryCache();
  const h = makeHandler({ fetch: f.fetch, cache });
  const c = ctx();
  const r = await h(get(`/p/${EAN}`), ENV, c);
  await Promise.all(c.pending);
  assertEquals(r.status, 200);
  const body = await r.text();
  assertStringIncludes(body, "Biszkopty testowe");
  assertStringIncludes(body, `<span class="num">82</span>`);
  assertStringIncludes(body, "ns-ingredients (NextSolutions)");
  assertStringIncludes(body, "github.com/Rippy1911/airon-sklad");
  assertStringIncludes(body, "Open Food Facts");
  assertEquals(cache.size(), 1, "raw upstream answer cached");
  await h(get(`/p/${EAN}`), ENV, ctx());
  assertEquals(f.calls.length, 1, "second view served from cache");
});

Deno.test("product page falls back to OFF and says so", async () => {
  const f = fakeFetch({ [NS]: () => new Response("", { status: 503 }), [OFF]: () => json(offProduct()) });
  const r = await makeHandler({ fetch: f.fetch, cache: null })(get(`/p/${EAN}`), ENV, ctx());
  const body = await r.text();
  assertStringIncludes(body, "Biszkopty z OFF");
  assertStringIncludes(body, "ns-food chwilowo nie odpowiada");
});

Deno.test("product without ingredients invites a photo, no score", async () => {
  const f = fakeFetch({ [NS]: () => json(nsProduct({ ingredients_text: "" })) });
  const body = await (await makeHandler({ fetch: f.fetch, cache: null })(get(`/p/${EAN}`), ENV, ctx()))
    .text();
  assertStringIncludes(body, "Nie znamy składu");
  assertStringIncludes(body, `/zdjecie?ean=${EAN}`);
});

Deno.test("EAN routes: redirect to canonical, 404 on invalid, 503 when both sources fail", async () => {
  const f = fakeFetch({
    [NS]: () => new Response("", { status: 500 }),
    [OFF]: () => new Response("", { status: 502 }),
  });
  const h = makeHandler({ fetch: f.fetch, cache: null });
  const r1 = await h(get(`/p/0${EAN}`), ENV, ctx());
  assertEquals([r1.status, r1.headers.get("location")], [301, `/p/${EAN}`]);
  assertEquals((await h(get("/p/4006381333932"), ENV, ctx())).status, 404);
  const r3 = await h(get(`/p/${EAN}`), ENV, ctx());
  assertEquals(r3.status, 503);
  assertStringIncludes(await r3.text(), "To nie znaczy, że go nie ma");
  const r4 = await h(get(`/szukaj?q=${EAN}`), ENV, ctx());
  assertEquals(r4.headers.get("location"), `/p/${EAN}`);
});

Deno.test("JSON API carries the engine credit, licence and source", async () => {
  const f = fakeFetch({ [NS]: () => json(nsProduct()) });
  const r = await makeHandler({ fetch: f.fetch, cache: null })(get(`/api/product/${EAN}`), ENV, ctx());
  const body = await r.json();
  assertEquals(body.data.score.score, 82);
  assertMatch(
    body.meta.powered_by,
    /^ns-ingredients \(NextSolutions\) https:\/\/github\.com\/NextSolutionsStudio\/ns-ingredients$/,
  );
  assertStringIncludes(body.meta.data, "ODbL");
  assertEquals(body.meta.source, "ns-food");
});

Deno.test("POST /api/analyze: scores text, caps length", async () => {
  const h = makeHandler({ cache: null });
  const post = (v: unknown) =>
    h(
      new Request("https://sklad.test/api/analyze", {
        method: "POST",
        body: JSON.stringify(v),
        headers: { "content-type": "application/json" },
      }),
      ENV,
      ctx(),
    );
  const ok = await (await post({ text: "Mąka pszenna, cukier, jaja, sól, miód" })).json();
  assertEquals(ok.data.score.score, 82);
  assertEquals((await post({ text: "x".repeat(5001) })).status, 413);
  assertEquals((await post({})).status, 400);
});

Deno.test("photo: read, then the person confirms before anything is rated", async () => {
  const db = await sqliteD1();
  const calls = { n: 0 };
  const h = makeHandler({ cache: null, reader: () => fakeReader(calls), budget: () => d1Budget(db) });
  const r = await postPhotos(h, photoForm(2));
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("cache-control"), "no-store");
  const body = await r.text();
  assertStringIncludes(body, "Sprawdź, czy dobrze odczytaliśmy");
  assertStringIncludes(body, `action="/ocen"`);
  assert(!body.includes("<script>alert"), "transcription escaped");
  assert(!body.includes(`class="num"`), "no score before confirmation");
  assertStringIncludes(body, `/p/${EAN}`, "OCR barcode validated and linked");
  assertEquals(calls.n, 2);
  assertEquals(db.db.prepare("SELECT used FROM photo_budget").get()?.used, 2);
});

Deno.test("photo: a resubmitted form is not read twice", async () => {
  const db = await sqliteD1();
  const calls = { n: 0 };
  const h = makeHandler({ cache: null, reader: () => fakeReader(calls), budget: () => d1Budget(db) });
  await postPhotos(h, photoForm(1));
  const again = await postPhotos(h, photoForm(1));
  assertEquals(again.status, 409);
  assertStringIncludes(await again.text(), "już odczytaliśmy");
  assertEquals(calls.n, 1);
});

Deno.test("photo: the daily cap counts photos and is never passed", async () => {
  const db = await sqliteD1();
  const calls = { n: 0 };
  const h = makeHandler({
    cache: null,
    reader: () => fakeReader(calls),
    budget: () => d1Budget(db),
    uuid: () => crypto.randomUUID(),
  });
  const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
  assertEquals((await postPhotos(h, photoForm(4, ids[0]))).status, 200); // 4 of 5
  assertEquals((await postPhotos(h, photoForm(2, ids[1]))).status, 429); // would be 6
  assertEquals((await postPhotos(h, photoForm(1, ids[2]))).status, 200); // 5 of 5
  assertEquals((await postPhotos(h, photoForm(1, ids[3]))).status, 429);
  assertEquals(calls.n, 5);
});

Deno.test("photo: fails closed when the budget store is down", async () => {
  const db = await sqliteD1();
  db.fail = true;
  const calls = { n: 0 };
  const h = makeHandler({ cache: null, reader: () => fakeReader(calls), budget: () => d1Budget(db) });
  assertEquals((await postPhotos(h, photoForm(1))).status, 503);
  assertEquals(calls.n, 0);
});

Deno.test("photo: rejects non-images by their bytes, too many photos, bad ids, missing keys", async () => {
  const db = await sqliteD1();
  const calls = { n: 0 };
  const h = makeHandler({ cache: null, reader: () => fakeReader(calls), budget: () => d1Budget(db) });
  const fake = new FormData();
  fake.set("request_id", UUID);
  fake.append(
    "photo",
    new File([new TextEncoder().encode("<svg onload=x>")], "x.jpg", { type: "image/jpeg" }),
  );
  assertEquals((await postPhotos(h, fake)).status, 400);
  assertEquals((await postPhotos(h, photoForm(5, crypto.randomUUID()))).status, 400);
  assertEquals((await postPhotos(h, photoForm(1, "not-a-uuid"))).status, 400);
  const off = makeHandler({ cache: null });
  assertEquals((await postPhotos(off, photoForm(1, crypto.randomUUID()))).status, 503);
  assertEquals(calls.n, 0);
});

Deno.test("photo: oversize body refused before it is read", async () => {
  const h = makeHandler({ cache: null, reader: () => fakeReader({ n: 0 }), budget: () => null });
  const r = await h(
    new Request("https://sklad.test/zdjecie", {
      method: "POST",
      body: "x",
      headers: { "content-length": String(64 * 1024 * 1024) },
    }),
    ENV,
    ctx(),
  );
  assertEquals(r.status, 413);
});

Deno.test("rating a confirmed transcription", async () => {
  const fd = new URLSearchParams({
    ingredients: "Mąka pszenna, cukier, jaja, sól, miód",
    may_contain: "sezam",
    from: "photo",
    name: "Biszkopty",
  });
  const r = await makeHandler({ cache: null })(
    new Request("https://sklad.test/ocen", { method: "POST", body: fd }),
    ENV,
    ctx(),
  );
  const body = await r.text();
  assertEquals(r.headers.get("cache-control"), "no-store");
  assertStringIncludes(body, `<span class="num">82</span>`);
  assertStringIncludes(body, "Odczyt ze zdjęcia, sprawdzony przez Ciebie");
  assertStringIncludes(body, "sezam");
});

Deno.test("rate limit applies to every page", async () => {
  const h = makeHandler({ cache: null });
  const r = await h(
    get("/"),
    { ...ENV, PAGE_LIMIT: { limit: () => Promise.resolve({ success: false }) } },
    ctx(),
  );
  assertEquals(r.status, 429);
  assertEquals(r.headers.get("x-robots-tag"), "noindex, nofollow");
});

Deno.test("rate-limit keys group IPv6 by /64", () => {
  assertEquals(ipKey("203.0.113.9"), "203.0.113.9");
  assertEquals(ipKey("2001:db8:abcd:12:1:2:3:4"), "2001:db8:abcd:12::/64");
  assertEquals(ipKey("2001:DB8::1"), "2001:db8:0:0::/64");
  assertEquals(ipKey("2001:db8:abcd:0012::9"), "2001:db8:abcd:12::/64");
});

Deno.test("ingredient chips link to knowledge-base pages that render", async () => {
  const f = fakeFetch({ [NS]: () => json(nsProduct()) });
  const h = makeHandler({ fetch: f.fetch, cache: null });
  const body = await (await h(get(`/p/${EAN}`), ENV, ctx())).text();
  const links = [...new Set([...body.matchAll(/href="(\/skladnik\/[^"]+)"/g)].map((m) => m[1]))];
  assert(links.length >= 4, `chip links: ${links.join(", ")}`);
  for (const link of links) {
    const r = await h(get(link), ENV, ctx());
    assertEquals(r.status, 200, link);
    assertStringIncludes(await r.text(), "Skala dowodów");
  }
  assertEquals((await h(get("/skladnik/nie-ma-takiego"), ENV, ctx())).status, 404);
});
