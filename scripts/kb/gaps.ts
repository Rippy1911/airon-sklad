// Rank the label items that keep products from getting a score, from one or more dumps (scripts/kb/dump.ts).
//
//   deno run --allow-read --allow-write scripts/kb/gaps.ts <out-dir> <dump.json> <corpus.json> \
//     [<dump.json> <corpus.json> ...] [--top 40]
//
// An item counts against a withheld label when it is an unknown additive (it blocks the score outright) or a
// counted leaf without a confident match (it lowers coverage). Items are keyed by their normalised name with
// numbers stripped, so "sól 1,5%" and "Sól" are one item.
//
// - share: each withheld label spreads one point over the items it still needs (every open blocker, plus the
//   misses needed to reach 80% coverage). An item that sits in many nearly-scorable labels ranks first.
// - gain / greedy_rank: how many more labels score once this item and every greedy pick before it match.
// - kind: "parser" when the item is the parser's to fix, not the KB's: two items joined by a dash or a full
//   stop, an additive class written without its colon ("stabilizator chlorek wapnia"), or a fragment of three
//   letters or fewer ("B6", "D"). A KB name must never be added for those.
//
// Writes gaps.json (every item) and job.md: the top KB items with label context for the drafting lane, then
// the parser-shaped items for a parser issue.
import { normName } from "../../vendor/ns-ingredients/src/core/normalize.ts";
import { kb } from "../../src/engine.ts";
import type { LabelRecord } from "./dump.ts";

const args = [...Deno.args];
const topAt = args.indexOf("--top");
const TOP = topAt >= 0 ? Number(args.splice(topAt, 2)[1]) : 40;
const [outDir, ...files] = args;
if (!outDir || !files.length || files.length % 2) {
  throw new Error("usage: gaps.ts <out-dir> <dump.json> <corpus.json> [<dump> <corpus> ...] [--top N]");
}

export const itemKey = (s: string) =>
  normName(s).replace(/\b\d+(?: \d+)?\b/g, " ").replace(/\s+/g, " ").trim();

interface Label extends LabelRecord {
  text: string;
}
const labels: Label[] = [];
for (let f = 0; f < files.length; f += 2) {
  const { records } = JSON.parse(await Deno.readTextFile(files[f])) as { records: LabelRecord[] };
  const texts = new Map<string, string>();
  for (const r of JSON.parse(await Deno.readTextFile(files[f + 1])).sample) {
    texts.set(r.barcode, r.ingredients_text);
  }
  for (const r of records) labels.push({ ...r, text: texts.get(r.barcode) ?? "" });
}
// A barcode in two corpora counts once (the first).
const seen = new Set<string>();
const withheld = labels.filter((l) => {
  if (seen.has(l.barcode)) return false;
  seen.add(l.barcode);
  return l.withheld !== null && l.withheld !== "empty";
});

const index = kb();
function parserReason(raw: string, key: string): string | null {
  if (/\s[-–—]\s/.test(raw)) return "dash joins two items";
  if (/[.;]\s*\p{L}/u.test(raw)) return "full stop joins two items";
  if (key.replace(/\s/g, "").length <= 3) return "fragment";
  if (/^(zawiera|zawieraja|moze zawierac|w tym)\b/.test(key)) return "allergen note parsed as an item";
  if (
    /\b(upraw ekologicznych|skladnik ekologiczny|rolnictwa ekologicznego|g na g|na g produktu)\b/.test(key)
  ) {
    return "label statement parsed as an item";
  }
  if (/\b(ameryka|europa|azja|afryka|kraj pochodzenia|pochodzenie)\b/.test(key)) return "origin statement";
  const words = key.split(" ");
  for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
    if (!index.classOf(words.slice(0, n).join(" "))) continue;
    const rest = index.match(words.slice(n).join(" "));
    if (rest && rest.matchType !== "fuzzy") return "class header without a colon";
  }
  return null;
}

interface Gap {
  key: string;
  kind: "kb" | "parser";
  parser_reason?: string;
  share: number;
  labels: number;
  blocks: number;
  scans: number;
  gain: number;
  greedy_rank: number | null;
  current: Record<string, number>;
  forms: Record<string, number>;
  examples: { barcode: string; name: string; context: string }[];
}
const gaps = new Map<string, Gap>();
const currentOf = (l: Label, raw: string) => {
  const hit = Object.values(l.items).find((v) => v.startsWith(`${raw} => `));
  return hit ? hit.slice(raw.length + 4) : "?";
};
const context = (text: string, raw: string) => {
  const at = text.toLowerCase().indexOf(raw.toLowerCase());
  if (at < 0) return text.slice(0, 140);
  const from = Math.max(0, at - 60), to = Math.min(text.length, at + raw.length + 60);
  return `${from ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`.replace(/\s+/g, " ");
};

const keysOf = new Map<Label, { miss: Set<string>; blk: Set<string>; perKey: Map<string, number> }>();
for (const l of withheld) {
  const miss = new Set<string>(), blk = new Set<string>(), perKey = new Map<string, number>();
  for (const raw of [...l.misses, ...l.blockers]) {
    const key = itemKey(raw);
    if (!key) continue;
    (l.blockers.includes(raw) ? blk : miss).add(key);
    let g = gaps.get(key);
    if (!g) {
      const why = parserReason(raw, key);
      g = {
        key,
        kind: why ? "parser" : "kb",
        ...(why ? { parser_reason: why } : {}),
        share: 0,
        labels: 0,
        blocks: 0,
        scans: 0,
        gain: 0,
        greedy_rank: null,
        current: {},
        forms: {},
        examples: [],
      };
      gaps.set(key, g);
    }
    g.forms[raw] = (g.forms[raw] ?? 0) + 1;
    const cur = currentOf(l, raw);
    g.current[cur] = (g.current[cur] ?? 0) + 1;
  }
  for (const m of l.misses) perKey.set(itemKey(m), (perKey.get(itemKey(m)) ?? 0) + 1);
  for (const k of blk) miss.delete(k);
  keysOf.set(l, { miss, blk, perKey });
  const [c, t] = l.coverage;
  const missNeeded = Math.max(0, Math.ceil(0.8 * t - c - 1e-9));
  const needed = blk.size + Math.min(missNeeded, miss.size);
  for (const key of new Set([...miss, ...blk])) {
    const g = gaps.get(key)!;
    g.labels++;
    if (blk.has(key)) g.blocks++;
    if (needed && (blk.has(key) || missNeeded > 0)) g.share += 1 / needed;
    g.scans += l.scans ?? 0;
    if (g.examples.length < 3) {
      const raw = Object.keys(g.forms).find((f) => itemKey(f) === key) ?? key;
      g.examples.push({ barcode: l.barcode, name: l.name, context: context(l.text, raw) });
    }
  }
}

// Greedy unlock order (incremental: per label, open blockers and fixed misses; per item, its labels).
const state = new Map<Label, { blkOpen: number; gained: number; done: boolean }>();
const labelsOf = new Map<string, Label[]>();
for (const l of withheld) {
  const { miss, blk } = keysOf.get(l)!;
  state.set(l, { blkOpen: blk.size, gained: 0, done: false });
  for (const k of new Set([...miss, ...blk])) labelsOf.set(k, [...(labelsOf.get(k) ?? []), l]);
}
const wouldUnlock = (l: Label, k: string) => {
  const s = state.get(l)!;
  if (s.done) return false;
  const { blk, perKey } = keysOf.get(l)!;
  const [c, t] = l.coverage;
  return s.blkOpen - (blk.has(k) ? 1 : 0) === 0 && t > 0 && (c + s.gained + (perKey.get(k) ?? 0)) / t >= 0.8;
};
let base = 0, rank = 0;
const fixed = new Set<string>();
while (rank < 300) {
  let best = "", bestGain = 0, bestShare = 0;
  for (const [k, ls] of labelsOf) {
    if (fixed.has(k) || gaps.get(k)!.kind === "parser") continue;
    const n = ls.filter((l) => wouldUnlock(l, k)).length;
    const sh = gaps.get(k)!.share;
    if (n > bestGain || (n === bestGain && n > 0 && sh > bestShare)) [best, bestGain, bestShare] = [k, n, sh];
  }
  if (!best) break;
  for (const l of labelsOf.get(best)!) {
    const s = state.get(l)!;
    const now = wouldUnlock(l, best);
    if (keysOf.get(l)!.blk.has(best)) s.blkOpen--;
    s.gained += keysOf.get(l)!.perKey.get(best) ?? 0;
    if (now) s.done = true;
  }
  fixed.add(best);
  base += bestGain;
  const g = gaps.get(best)!;
  g.gain = bestGain;
  g.greedy_rank = ++rank;
}

const ranked = [...gaps.values()].sort((a, b) =>
  b.share - a.share || b.labels - a.labels || b.scans - a.scans
);
for (const g of ranked) g.share = Math.round(g.share * 100) / 100;
await Deno.mkdir(outDir, { recursive: true });
await Deno.writeTextFile(
  `${outDir}/gaps.json`,
  JSON.stringify(
    { kb: index.version, withheld: withheld.length, greedy_unlock_kb_only: base, gaps: ranked },
    null,
    1,
  ),
);
const kbTop = ranked.filter((g) => g.kind === "kb").slice(0, TOP);
const parserTop = ranked.filter((g) => g.kind === "parser").slice(0, 25);
const fmt = (m: Record<string, number>, n = 4) =>
  Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`).join("; ")
    .replaceAll("|", "/");
const md = [
  `# KB gap job (${index.version}): top ${kbTop.length} items`,
  "",
  `Withheld labels in the corpora: ${withheld.length}. Matching every KB-fixable item in greedy order would let ` +
  `${base} more score. "share" = how much of the remaining work to unlock labels this item is; "labels" = ` +
  `withheld labels it appears in; "blocks" = labels where it is an unidentified additive.`,
  "",
  "| # | item (normalised) | share | labels | blocks | current match | label spellings |",
  "|---|---|---|---|---|---|---|",
  ...kbTop.map((g, i) =>
    `| ${i + 1} | \`${g.key}\` | ${g.share} | ${g.labels} | ${g.blocks} | ${fmt(g.current, 2)} | ${
      fmt(g.forms)
    } |`
  ),
  "",
  "## Label context",
  "",
  ...kbTop.flatMap((g, i) => [
    `### ${i + 1}. \`${g.key}\``,
    ...g.examples.map((e) => `- ${e.barcode} ${e.name}: ${e.context.replaceAll("\n", " ")}`),
    "",
  ]),
  "## Parser-shaped items (not for the KB: a parser issue)",
  "",
  "| item | why | share | labels | label spellings |",
  "|---|---|---|---|---|",
  ...parserTop.map((g) =>
    `| \`${g.key}\` | ${g.parser_reason} | ${g.share} | ${g.labels} | ${fmt(g.forms, 3)} |`
  ),
  "",
].join("\n");
await Deno.writeTextFile(`${outDir}/job.md`, md);
console.log(
  `${withheld.length} withheld labels, ${gaps.size} distinct items (${
    ranked.filter((g) => g.kind === "parser").length
  } parser-shaped); KB greedy unlock ${base}; top ${kbTop.length} -> ${outDir}/job.md`,
);
