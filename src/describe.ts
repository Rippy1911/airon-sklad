/**
 * A short Polish description built only from the analysis and the score: no model prose, so nothing on the page is
 * invented. Each sentence states what the label says, or that we could not tell.
 */
import type { AnalysisResult } from "./engine.ts";
import type { Score } from "./score.ts";

const ALLERGEN_PL: Record<string, string> = {
  "allergen.gluten": "gluten",
  "allergen.crustaceans": "skorupiaki",
  "allergen.eggs": "jaja",
  "allergen.fish": "ryby",
  "allergen.peanuts": "orzeszki ziemne",
  "allergen.soybeans": "soja",
  "allergen.milk": "mleko",
  "allergen.nuts": "orzechy",
  "allergen.celery": "seler",
  "allergen.mustard": "gorczyca",
  "allergen.sesame": "sezam",
  "allergen.sulphites": "siarczyny",
  "allergen.lupin": "łubin",
  "allergen.molluscs": "mięczaki",
};

export function allergens(a: AnalysisResult): { sure: string[]; possible: string[] } {
  const sure: string[] = [];
  const possible: string[] = [];
  for (const f of a.flags) {
    const name = ALLERGEN_PL[f.code];
    if (!name) continue;
    (f.certainty === "yes" ? sure : possible).push(name);
  }
  return { sure, possible: possible.filter((p) => !sure.includes(p)) };
}

const DIET_PL: Record<string, string> = {
  vegan: "wegańskie",
  vegetarian: "wegetariańskie",
  gluten_free: "bez glutenu",
  lactose_free: "bez laktozy",
};
const STATUS_PL: Record<string, string> = { yes: "tak", no: "nie", maybe: "może", unknown: "nie wiadomo" };

export function diets(a: AnalysisResult): { name: string; status: string; mark: string }[] {
  return Object.entries(a.diets).map(([k, v]) => ({
    name: DIET_PL[k] ?? k,
    status: v.status,
    mark: STATUS_PL[v.status] ?? v.status,
  }));
}

const ordinal = (n: number) => `${n}.`;

export function describe(a: AnalysisResult, s: Score): string[] {
  const out: string[] = [];
  if (!s.itemCount) return ["Nie znaleźliśmy listy składników."];
  out.push(
    `Skład ma ${s.itemCount} ${
      s.itemCount === 1 ? "pozycję" : s.itemCount < 5 ? "pozycje" : "pozycji"
    }; rozpoznaliśmy pewnie ${s.coverage.confident} z ${s.coverage.total}.`,
  );
  const al = allergens(a);
  if (al.sure.length) out.push(`Alergeny z etykiety: ${al.sure.join(", ")}.`);
  else out.push("Nie znaleźliśmy w składzie żadnego z 14 alergenów UE.");
  if (a.may_contain.length) out.push(`Może zawierać: ${a.may_contain.map((m) => m.text).join(", ")}.`);
  const sugar = s.penalties.find((p) => p.group === "added_sugar");
  if (sugar) {
    out.push(
      `Cukry dodane: ${sugar.items.map((i) => `${i.name} (${ordinal(i.position)} miejsce)`).join(", ")}.`,
    );
  }
  const others = s.penalties.filter((p) => p.group !== "added_sugar");
  if (others.length) out.push(`Obniża wynik także: ${others.map((p) => p.label.toLowerCase()).join(", ")}.`);
  if (s.withheld?.reason === "unknown_additive") {
    out.push(`Nie rozpoznaliśmy: ${s.withheld.detail.join(", ")}. Bez tego nie wystawiamy wyniku.`);
  } else if (s.withheld?.reason === "coverage") {
    out.push(`Rozpoznaliśmy za mało składu, by wystawić wynik.`);
  } else if (s.score !== null && !s.penalties.length) {
    out.push("Nic w składzie nie obniża wyniku według reguł v0.1.");
  }
  return out;
}
