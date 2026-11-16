import { assert, assertEquals } from "@std/assert";
import { describe } from "../src/describe.ts";
import { analyse } from "../src/engine.ts";
import { score } from "../src/score.ts";

const rate = (t: string) => score(analyse(t), t);

Deno.test("sugars count once, weighted by the first sugar's place", () => {
  const s = rate("Mąka pszenna, cukier, jaja, sól, miód");
  assertEquals(s.score, 82);
  assertEquals(s.band?.id, "good");
  assertEquals(s.penalties.map((p) => [p.group, p.weight, p.items.map((i) => i.position)]), [[
    "added_sugar",
    18,
    [2, 5],
  ]]);
  assertEquals(rate("Mąka pszenna, jaja, sól, cukier").penalties[0].weight, 12);
  assertEquals(
    rate("Mąka pszenna, jaja, sól, woda, skrobia ziemniaczana, olej rzepakowy, cukier").penalties[0]?.weight,
    6,
  );
});

Deno.test("a sugar inside a compound takes the compound's place", () => {
  const s = rate(
    "czekolada mleczna (cukier, masło kakaowe, mleko w proszku pełne, miazga kakaowa), orzechy laskowe 20%, sól",
  );
  assertEquals(s.penalties.find((p) => p.group === "added_sugar")?.items[0].position, 1);
  assertEquals(s.penalties.find((p) => p.group === "added_sugar")?.weight, 18);
});

Deno.test("nothing to deduct: 100", () => {
  assertEquals(rate("Mąka pszenna, jaja, sól").score, 100);
});

Deno.test("an unrecognised additive withholds the score", () => {
  const s = rate("mąka pszenna, cukier, E1599, sól");
  assertEquals(s.score, null);
  assertEquals(s.withheld?.reason, "unknown_additive");
});

Deno.test("an unknown item under an inherited additive header withholds the score", () => {
  const s = rate("mąka pszenna, cukier, barwniki: E150d, nowybarwnik");
  assertEquals(s.withheld, { reason: "unknown_additive", detail: ["nowybarwnik"] });
});

Deno.test("dash-separated lists and dash class headers: each additive counted at its own place", () => {
  const s = rate(
    "mąka pszenna, węglany amonu - węglany sodu, substancja konserwująca - azotyn sodu, sól, " +
      "regulator kwasowości - kwas cytrynowy",
  );
  assertEquals(s.coverage, { total: 6, confident: 6, ratio: 1 });
  // The nitrite sits at place 4 once the raising agents count as two items; the header map must agree.
  assertEquals(s.penalties.map((p) => [p.group, p.items.map((i) => [i.name, i.position])]), [[
    "nitrosamines",
    [["azotyn sodu", 4]],
  ]]);
  assertEquals(s.score, 90);
});

Deno.test("an additive header after a dash list still covers its own item", () => {
  // The dash list becomes two items, moving the inherited "barwniki" header's unknown item to place 6; the
  // header map must move with it, or the unknown colour stops withholding the score.
  const s = rate("mąka pszenna, węglany amonu - węglany sodu, sól, barwniki: E150d, nowybarwnik");
  assertEquals(s.withheld, { reason: "unknown_additive", detail: ["nowybarwnik"] });
});

Deno.test("low confident coverage withholds the score", () => {
  const s = rate("qwertyzz, mąka pszenna, cukier");
  assertEquals(s.score, null);
  assertEquals(s.withheld?.reason, "coverage");
  assertEquals(s.coverage, { total: 3, confident: 2, ratio: 2 / 3 });
});

Deno.test("empty list: no score", () => {
  assertEquals(rate("").withheld?.reason, "empty");
});

Deno.test("fuzzy matches never deduct", () => {
  // A misspelling the analyser can only match fuzzily: it lowers coverage, it never adds a penalty.
  const s = rate("mąka pszenna, cukierr, jaja");
  assert(s.penalties.every((p) => p.items.every((i) => i.name !== "cukierr")));
});

Deno.test("same label, same score (deterministic)", () => {
  const t = "woda, cukier, dwutlenek węgla, regulator kwasowości: kwas cytrynowy, aromat, słodzik: aspartam";
  assertEquals(rate(t), rate(t));
});

Deno.test("description is built from the analysis, in Polish", () => {
  const t = "mąka pszenna, cukier, olej rzepakowy, sól\nMoże zawierać: orzechy laskowe, sezam";
  const lines = describe(analyse(t), rate(t));
  assert(lines.some((l) => l.startsWith("Alergeny z etykiety: gluten")), lines.join(" | "));
  assert(lines.some((l) => l.includes("Może zawierać: orzechy laskowe, sezam")), lines.join(" | "));
  assert(lines.some((l) => l.includes("cukier (2. miejsce)")), lines.join(" | "));
});

Deno.test("Polish agreement for the number of groups", async () => {
  const { groupsPl } = await import("../src/pages.ts");
  assertEquals([1, 2, 4, 5, 12, 22].map(groupsPl), [
    "wpływa jedna grupa",
    "wpływają 2 grupy",
    "wpływają 4 grupy",
    "wpływa 5 grup",
    "wpływa 12 grup",
    "wpływają 22 grupy",
  ]);
});
