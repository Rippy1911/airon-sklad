// Score a JSON sample of labels ({sample: [{name, ingredients_text}]}) and print the distribution.
// deno run --allow-read scripts/measure.ts <sample.json>
import { analyse } from "../src/engine.ts";
import { score } from "../src/score.ts";

const { sample } = JSON.parse(await Deno.readTextFile(Deno.args[0])) as {
  sample: { name: string; ingredients_text: string }[];
};
const reasons = new Map<string, number>();
const blockers = new Map<string, number>();
const groups = new Map<string, number>();
const unassessed = new Map<string, number>();
const scores: number[] = [];
let withUnassessed = 0, scoredWithUnassessed = 0;
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
for (const row of sample) {
  const a = analyse(row.ingredients_text);
  const s = score(a, row.ingredients_text);
  if (s.unassessed.length) withUnassessed++;
  for (const u of s.unassessed) bump(unassessed, u.replace(/^.*\((E\w+)\)$/, "$1"));
  if (s.score === null) {
    bump(reasons, s.withheld!.reason);
    if (s.withheld!.reason === "unknown_additive") {
      for (const d of s.withheld!.detail) bump(blockers, d.toLowerCase());
    }
  } else {
    scores.push(s.score);
    if (s.unassessed.length) scoredWithUnassessed++;
    for (const p of s.penalties) bump(groups, `${p.group} −${p.weight}`);
  }
}
scores.sort((a, b) => a - b);
const q = (p: number) => scores[Math.floor((scores.length - 1) * p)];
const top = (m: Map<string, number>, n = 15) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
console.log(JSON.stringify(
  {
    labels: sample.length,
    scored: scores.length,
    withheld: Object.fromEntries(reasons),
    score_p10_p50_p90: [q(0.1), q(0.5), q(0.9)],
    bands: {
      good: scores.filter((s) => s >= 80).length,
      mid: scores.filter((s) => s >= 50 && s < 80).length,
      low: scores.filter((s) => s < 50).length,
    },
    penalties: top(groups),
    top_blockers: top(blockers, 20),
    labels_with_unassessed_additive: withUnassessed,
    scored_with_unassessed_additive: scoredWithUnassessed,
    top_unassessed: top(unassessed, 15),
  },
  null,
  1,
));
