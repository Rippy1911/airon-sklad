// Fetch the most-scanned products sold in Poland that have a Polish ingredient list, from Open Food Facts (ODbL),
// read-only. Writes a corpus in the shape scripts/measure.ts and scripts/kb/dump.ts read.
//
//   deno run --allow-net=search.openfoodfacts.org,world.openfoodfacts.org --allow-read --allow-write \
//     scripts/kb/popular.ts <out.json> [target=800] [max_codes=3000]
//
// Popularity is OFF's `unique_scans_n` (distinct app users who scanned the barcode), ranked by OFF's search
// service for products tagged as sold in Poland. Each product's Polish list then comes from the product API,
// about 90 requests a minute (OFF allows 100 for product reads). Only canonical EAN-8/EAN-13 codes are kept.
// Re-running with the same <out.json> resumes: products already in it are not fetched again.
const [out, targetArg, maxArg] = Deno.args;
if (!out) throw new Error("usage: popular.ts <out.json> [target] [max_codes]");
const target = Number(targetArg ?? 800), maxCodes = Number(maxArg ?? 3000);
const UA = "airon-sklad-kb-coverage/0.1 (open-source ingredient research)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ean = (c: string) => {
  if (!/^\d{8}$|^\d{13}$/.test(c)) return false;
  const d = [...c].map(Number);
  const check = d.pop()!;
  const sum = d.reverse().reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
};
async function getJson(url: string): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA } }).catch(() => null);
    if (res?.ok) return await res.json();
    if (res?.status === 404) return (await res.body?.cancel(), null);
    await res?.body?.cancel();
    await sleep(5000 * 2 ** attempt);
  }
  console.error(`gave up: ${url}`);
  return null;
}

type Row = { barcode: string; name: string; brands: string; scans: number; ingredients_text: string };
const rows = new Map<string, Row>();
const skipped = new Set<string>();
try {
  const prev = JSON.parse(await Deno.readTextFile(out));
  for (const r of prev.sample as Row[]) rows.set(r.barcode, r);
  for (const c of (prev.no_polish_list ?? []) as string[]) skipped.add(c);
  console.error(`resuming: ${rows.size} products, ${skipped.size} without a Polish list`);
} catch { /* fresh run */ }

const codes: { code: string; scans: number }[] = [];
for (let page = 1; codes.length < maxCodes; page++) {
  const q = encodeURIComponent('countries_tags:"en:poland"');
  const body = await getJson(
    `https://search.openfoodfacts.org/search?q=${q}&sort_by=-unique_scans_n&page_size=100&page=${page}` +
      `&fields=code,unique_scans_n`,
  );
  const hits = (body?.hits ?? []) as { code: string; unique_scans_n?: number }[];
  if (!hits.length) break;
  for (const h of hits) {
    if (ean(String(h.code))) codes.push({ code: String(h.code), scans: h.unique_scans_n ?? 0 });
  }
  await sleep(1000);
}
console.error(`${codes.length} ranked codes`);

const save = () =>
  Deno.writeTextFile(
    out,
    JSON.stringify({
      source:
        "Open Food Facts (ODbL): search.openfoodfacts.org countries_tags en:poland by -unique_scans_n, " +
        "then /api/v2/product ingredients_text_pl",
      fetched: new Date().toISOString(),
      sample: [...rows.values()].sort((a, b) => b.scans - a.scans),
      no_polish_list: [...skipped],
    }),
  );
let n = 0;
for (const { code, scans } of codes) {
  if (rows.size >= target) break;
  if (rows.has(code) || skipped.has(code)) continue;
  const body = await getJson(
    `https://world.openfoodfacts.org/api/v2/product/${code}?fields=code,product_name,product_name_pl,brands,ingredients_text_pl`,
  );
  // A failed fetch (retries exhausted) is not "no Polish list": leave the code for the next run.
  if (!body) continue;
  const p = (body.product ?? {}) as Record<string, unknown>;
  const text = String(p.ingredients_text_pl ?? "").trim();
  if (text.length >= 3) {
    rows.set(code, {
      barcode: code,
      name: String(p.product_name_pl || p.product_name || ""),
      brands: String(p.brands ?? ""),
      scans,
      ingredients_text: text,
    });
  } else skipped.add(code);
  if (++n % 50 === 0) {
    await save();
    console.error(`${n} fetched: ${rows.size} with a Polish list`);
  }
  await sleep(650);
}
await save();
console.log(`${rows.size} products with a Polish list -> ${out}`);
