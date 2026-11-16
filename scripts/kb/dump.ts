// Score every label of a corpus with airon-sklad's own rules and write one record per label: score or withheld
// reason, coverage, every item's match, the penalties, and "joined items" (a confident sub-phrase match whose
// leftover words name another ingredient: the label's punctuation joined two items).
//
//   deno run --allow-read --allow-write scripts/kb/dump.ts <corpus.json> <out.json>
//
// It scores against vendor/ns-ingredients. scripts/kb/check.ts runs it under an import map that points
// vendor/ns-ingredients/ at another checkout, so one script measures any KB.
import { analyse, flatItems, type ItemResult, kb } from "../../src/engine.ts";
import { isConfident, RULES, score } from "../../src/score.ts";
import { normName } from "../../vendor/ns-ingredients/src/core/normalize.ts";

export interface LabelRecord {
  barcode: string;
  name: string;
  scans?: number;
  score: number | null;
  withheld: string | null;
  /** Unknown additives (withheld: unknown_additive). */
  blockers: string[];
  /** Counted leaves without a confident match. */
  misses: string[];
  coverage: [number, number];
  penalties: string[];
  /** path -> "name => id[/variant] type@confidence[ ✓]" */
  items: Record<string, string>;
  joined: string[];
}

const scoredCodes = new Set(RULES.groups.flatMap((g: { codes: string[] }) => g.codes));
const isLeaf = (it: ItemResult) => !it.children.some((c) => c.role === "ingredient" || c.role === "class");

export function record(row: { barcode: string; name?: string; scans?: number; ingredients_text: string }) {
  const index = kb();
  const a = analyse(row.ingredients_text);
  const s = score(a, row.ingredients_text);
  const all = flatItems(a.items);
  const leaves = all.filter((it) =>
    (it.role === "ingredient" || it.role === "class") && (isLeaf(it) || !!it.match)
  );
  const joined: string[] = [];
  for (const it of all) {
    if (!it.match || it.match.match_type !== "sub_phrase" || !isConfident(it.match)) continue;
    const m = index.match(it.name);
    if (!m) continue;
    const left = normName(it.name).replace(m.matched, " ").replace(/\b\d+([ .,]\d+)?\b/g, " ").trim();
    const other = left ? index.match(left) : null;
    if (!other || other.matchType === "fuzzy" || other.ingredientId === m.ingredientId) continue;
    const ing = index.get(other.ingredientId)!;
    const deducts = (ing.assertions ?? []).some((x) => scoredCodes.has(x.code) && x.certainty === "yes");
    joined.push(
      `"${it.name}" => ${m.ingredientId}; leftover "${left}" = ${other.ingredientId}${
        deducts ? " (deducts)" : ""
      }`,
    );
  }
  const rec: LabelRecord = {
    barcode: row.barcode,
    name: row.name ?? "",
    scans: row.scans,
    score: s.score,
    withheld: s.withheld?.reason ?? null,
    blockers: s.withheld?.reason === "unknown_additive" ? s.withheld.detail : [],
    misses: leaves.filter((it) => !isConfident(it.match)).map((it) => it.name),
    coverage: [s.coverage.confident, s.coverage.total],
    penalties: s.penalties.map((p) => `${p.group} -${p.weight} [${p.items.map((i) => i.name).join(" | ")}]`),
    items: Object.fromEntries(all.map((it) => [
      it.path,
      `${it.name} => ${
        it.match
          ? `${it.match.ingredient_id}${
            it.variant?.id ? "/" + it.variant.id : ""
          } ${it.match.match_type}@${it.match.confidence}${isConfident(it.match) ? " ✓" : ""}`
          : "-"
      }`,
    ])),
    joined,
  };
  return rec;
}

if (import.meta.main) {
  const [corpus, out] = Deno.args;
  if (!corpus || !out) throw new Error("usage: dump.ts <corpus.json> <out.json>");
  const { sample } = JSON.parse(await Deno.readTextFile(corpus)) as {
    sample: { barcode: string; name?: string; scans?: number; ingredients_text: string }[];
  };
  const records = sample.map(record);
  await Deno.writeTextFile(out, JSON.stringify({ kb: kb().version ?? null, records }));
  console.log(`${records.length} labels, ${records.filter((r) => r.score !== null).length} scored -> ${out}`);
}
