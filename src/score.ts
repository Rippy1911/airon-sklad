/**
 * Scoring rules v0.1 (rules/v0.1.json, CC BY-SA 4.0). Deterministic: the same label always gives the same score.
 *
 * What counts, per deduction: a trigger the analyser marks certain ("yes"), on an item matched with confidence
 * (exact, variant, E-number, or a sub-phrase ≥ 0.8; never fuzzy), whose basis is the ingredient itself or a variant
 * the label names (never an inferred, "prior" variant). Everything else is shown as possible, never deducted.
 *
 * When there is no score: no ingredient list; confident coverage under `coverage_min`; or an unrecognised item that
 * could carry a deduction: an E-number, a bare additive class, or an item under an additive header ("barwnik: …"),
 * whether the header is its own or inherited from an earlier item ("barwniki: E150d, nowy-barwnik").
 */
import rules from "../rules/v0.1.json" with { type: "json" };
import { nameOracle } from "../vendor/ns-ingredients/src/core/analyze.ts";
import { parseLabel, walk } from "../vendor/ns-ingredients/src/core/parse.ts";
import { type AnalysisResult, flatItems, type ItemResult, kb } from "./engine.ts";

export const RULES = rules;
type Group = (typeof rules.groups)[number];

export interface Penalty {
  group: string;
  label: string;
  weight: number;
  why: string;
  items: { name: string; position: number; path: string }[];
  grade: string;
  sources: { id: string; title: string; url: string }[];
  notes: string[];
}

export interface Possible {
  code: string;
  label: string;
  items: string[];
}

export interface Score {
  version: string;
  score: number | null;
  band: { id: string; label: string } | null;
  withheld: null | { reason: "empty" | "coverage" | "unknown_additive"; detail: string[] };
  penalties: Penalty[];
  possible: Possible[];
  /** Additives we recognise by name only: no assessment in the knowledge base yet, so no deduction either way. */
  unassessed: string[];
  coverage: { total: number; confident: number; ratio: number };
  itemCount: number;
}

const E_RE = /(?<![\p{L}\p{N}])(?:e|ins)[\s-]*\d{3,4}/iu;
const COUNTED_BASIS = new Set(["ingredient", "label_variant"]);
const GRADE = ["A", "B", "C", "D"];

export function isConfident(m: ItemResult["match"]): boolean {
  if (!m) return false;
  if (m.match_type === "exact" || m.match_type === "variant" || m.match_type === "e_number") return true;
  return m.match_type === "sub_phrase" && m.confidence >= 0.8;
}

const isLeaf = (it: ItemResult) => !it.children.some((c) => c.role === "ingredient" || c.role === "class");

/** Leaf items, counted the way the analyser counts coverage. */
function counted(items: ItemResult[]): ItemResult[] {
  return flatItems(items).filter((it) =>
    (it.role === "ingredient" || it.role === "class") && (isLeaf(it) || !!it.match)
  );
}

/**
 * Position on the label: the top-level index (1-based) of the item or of the compound it sits in. A sugar inside
 * "nadzienie (cukier, …)" at place 4 counts as place 4: the label orders compounds, not their parts.
 */
const position = (path: string) => Number(path.split(".")[0]);

/** Additive headers from the parser, own or inherited, by item path. */
function additiveHeaders(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const index = kb();
  // The same name oracle as the analyser, so a dash or full-stop split gives the same item paths.
  for (const p of walk(parseLabel(text, { lang: "pl", kb: nameOracle(index) }).items)) {
    const h = p.header ?? p.inheritedHeader;
    if (h && index.classOf(h)) out.set(p.path, h);
  }
  return out;
}

function blockers(a: AnalysisResult, text: string): string[] {
  const headers = additiveHeaders(text);
  const out: string[] = [];
  for (const it of flatItems(a.items)) {
    if (it.role === "qualifier" || it.role === "e_number" && it.match) continue;
    if (!isLeaf(it) || isConfident(it.match)) continue;
    if (
      it.role === "e_number" || it.role === "class" || it.function || headers.has(it.path) ||
      E_RE.test(it.name)
    ) {
      out.push(it.name);
    }
  }
  return [...new Set(out)];
}

function unassessed(a: AnalysisResult): string[] {
  const index = kb();
  const out: string[] = [];
  for (const it of flatItems(a.items)) {
    if (!isConfident(it.match)) continue;
    const ing = index.get(it.match!.ingredient_id);
    if (!ing || ing.review_status !== "imported") continue;
    if (ing.type === "additive" || ing.e_number) {
      out.push(ing.e_number ? `${it.name} (${ing.e_number})` : it.name);
    }
  }
  return [...new Set(out)];
}

export function score(a: AnalysisResult, text: string): Score {
  const leaves = counted(a.items);
  const confident = leaves.filter((it) => isConfident(it.match)).length;
  const coverage = { total: leaves.length, confident, ratio: leaves.length ? confident / leaves.length : 0 };
  const byPath = new Map(flatItems(a.items).map((it) => [it.path, it]));
  const groupOf = new Map<string, Group>();
  for (const g of rules.groups) for (const c of g.codes) groupOf.set(c, g);

  // A trigger counts only on a confidently matched item, certain, on the ingredient or a label-named variant.
  const counts = (t: AnalysisResult["flags"][number]["triggers"][number]) =>
    t.certainty === "yes" && COUNTED_BASIS.has(t.basis) && isConfident(byPath.get(t.path)?.match ?? null);

  const possible: Possible[] = [];
  for (const f of a.flags) {
    if (!groupOf.has(f.code)) continue;
    const loose = f.triggers.filter((t) => !counts(t));
    if (loose.length && !f.triggers.some(counts)) {
      possible.push({
        code: f.code,
        label: f.label,
        items: [...new Set(loose.map((t) => byPath.get(t.path)?.name ?? ""))].filter(Boolean),
      });
    }
  }
  const base = {
    version: rules.version,
    coverage,
    itemCount: a.items.length,
    penalties: [] as Penalty[],
    possible,
    unassessed: unassessed(a),
  };

  if (!leaves.length) return { ...base, score: null, band: null, withheld: { reason: "empty", detail: [] } };
  const blocked = blockers(a, text);
  if (blocked.length) {
    return { ...base, score: null, band: null, withheld: { reason: "unknown_additive", detail: blocked } };
  }
  if (coverage.ratio < rules.coverage_min) {
    const unknown = leaves.filter((it) => !isConfident(it.match)).map((it) => it.name);
    return { ...base, score: null, band: null, withheld: { reason: "coverage", detail: unknown } };
  }

  const index = kb();
  const penalties: Penalty[] = [];
  for (const g of rules.groups) {
    const triggers = a.flags.filter((f) => g.codes.includes(f.code)).flatMap((f) =>
      f.triggers.filter(counts)
    );
    if (!triggers.length) continue;
    const items = [
      ...new Map(
        triggers.map((
          t,
        ) => [t.path, { name: byPath.get(t.path)!.name, position: position(t.path), path: t.path }]),
      ).values(),
    ].sort((x, y) => x.position - y.position || x.path.localeCompare(y.path));
    const first = items[0].position;
    const weight = "by_position" in g && g.by_position
      ? (g.by_position.find((b) => first <= b.upto)?.weight ?? 0)
      : ("weight" in g ? (g.weight ?? 0) : 0);
    const sourceIds = [...new Set(triggers.flatMap((t) => t.sources.map((s) => s.id)))];
    penalties.push({
      group: g.id,
      label: g.label,
      weight,
      why: g.why,
      items,
      grade: triggers.map((t) => t.grade).sort((x, y) => GRADE.indexOf(x) - GRADE.indexOf(y))[0],
      sources: sourceIds.map((id) => {
        const s = index.sources.get(id);
        return { id, title: s?.title ?? id, url: s?.url ?? "" };
      }),
      notes: [...new Set(triggers.map((t) => t.note).filter(Boolean))].slice(0, 2),
    });
  }
  const total = Math.max(0, 100 - penalties.reduce((s, p) => s + p.weight, 0));
  const band = rules.bands.find((b) => total >= b.min)!;
  return { ...base, penalties, score: total, band: { id: band.id, label: band.label }, withheld: null };
}
