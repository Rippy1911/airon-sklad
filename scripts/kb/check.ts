// The corpus gate for a knowledge-base change: score the same corpora against two ns-ingredients checkouts
// and compare. Run it before merging any KB batch.
//
//   deno run -A scripts/kb/check.ts --before <ns-ingredients dir> --after <ns-ingredients dir> \
//     --out <dir> <corpus.json> [<corpus.json> ...]
//
// With --dump-only (no --after) it only writes the before-side dumps, for scripts/kb/gaps.ts.
//
// For each side it rebuilds dist/kb-bundle.json in that checkout, then runs scripts/kb/dump.ts under an import
// map that points vendor/ns-ingredients/ at it, so airon-sklad's own scoring code runs unmodified.
//
// FAIL (exit 1) when, on any corpus: fewer labels score; a label that scored is now withheld; or an item that was
// matched confidently lost its match or now matches a different ingredient. A batch must also score more labels
// on at least one corpus. WARN lines are for the reviewer's spot-check: score changes on labels that scored
// before, every newly confident match, and new "joined items" (two ingredients the label's punctuation ran
// together, where one now hides the other).
import { resolve, toFileUrl } from "@std/path";
import type { LabelRecord } from "./dump.ts";

const argv = [...Deno.args];
const take = (flag: string) => {
  const i = argv.indexOf(flag);
  if (i < 0) return "";
  return argv.splice(i, 2)[1];
};
const dumpOnly = argv.includes("--dump-only");
if (dumpOnly) argv.splice(argv.indexOf("--dump-only"), 1);
const before = take("--before"), after = take("--after"), out = take("--out");
const corpora = argv;
if (!before || (!after && !dumpOnly) || !out || !corpora.length) {
  throw new Error(
    "usage: check.ts --before <dir> --after <dir> --out <dir> <corpus.json> [...]\n" +
      "       check.ts --before <dir> --out <dir> --dump-only <corpus.json> [...]   (dumps one KB for gaps.ts)",
  );
}
await Deno.mkdir(out, { recursive: true });
const here = new URL("../../", import.meta.url);
const vendorUrl = new URL("vendor/ns-ingredients/", here).href;
const sklad = JSON.parse(await Deno.readTextFile(new URL("deno.json", here)));

async function run(cmd: string, args: string[], cwd?: string) {
  const r = await new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped" }).output();
  const text = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} (cwd ${cwd ?? "."}) exited ${r.code}\n${text}`);
  return text;
}

async function side(name: string, dir: string) {
  const abs = await Deno.realPath(resolve(dir));
  await run("deno", ["run", "--allow-read", "--allow-write=dist", "scripts/build-kb-bundle.ts"], abs);
  const target = toFileUrl(abs).href.replace(/\/?$/, "/");
  const cfg = `${out}/${name}.deno.json`;
  const imports = { ...sklad.imports, ...(target === vendorUrl ? {} : { [vendorUrl]: target }) };
  await Deno.writeTextFile(cfg, JSON.stringify({ imports, nodeModulesDir: "none" }, null, 1));
  const kbVersion = JSON.parse(await Deno.readTextFile(`${abs}/dist/kb-bundle.json`)).version as string;
  const res: Record<string, LabelRecord[]> = {};
  for (const c of corpora) {
    const file = `${out}/${name}-${c.replace(/^.*[\\/]/, "").replace(/\.json$/, "")}.dump.json`;
    await run("deno", [
      "run",
      "--no-lock",
      `--config=${cfg}`,
      "--allow-read",
      `--allow-write=${out}`,
      new URL("scripts/kb/dump.ts", here).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      c,
      file,
    ]);
    res[c] = JSON.parse(await Deno.readTextFile(file)).records;
  }
  return { dir: abs, kbVersion, res };
}

const B = await side("before", before);
if (dumpOnly) {
  console.log(`${B.kbVersion}: dumps in ${out}/before-*.dump.json`);
  Deno.exit(0);
}
const A = await side("after", after);

const fails: string[] = [], warns: string[] = [], lines: string[] = [];
const summary: Record<string, unknown> = {};
const tick = (s: string | undefined) => !!s && s.endsWith(" ✓");
const target = (s: string) => s.replace(/^.* => /, "").replace(/ .*$/, "");
const newMatches = new Map<string, { n: number; eg: string }>();
let improvedSomewhere = false;

for (const c of corpora) {
  const b = new Map(B.res[c].map((r) => [r.barcode, r])), a = new Map(A.res[c].map((r) => [r.barcode, r]));
  const count = (m: Map<string, LabelRecord>) => {
    const recs = [...m.values()];
    const reasons: Record<string, number> = {};
    for (const r of recs) if (r.withheld) reasons[r.withheld] = (reasons[r.withheld] ?? 0) + 1;
    const scores = recs.map((r) => r.score).filter((s): s is number => s !== null);
    return {
      labels: recs.length,
      scored: scores.length,
      withheld: reasons,
      bands: {
        good: scores.filter((s) => s >= 80).length,
        mid: scores.filter((s) => s >= 50 && s < 80).length,
        low: scores.filter((s) => s < 50).length,
      },
    };
  };
  const cb = count(b), ca = count(a);
  summary[c] = { before: cb, after: ca };
  const name = c.replace(/^.*[\\/]/, "");
  lines.push(
    `## ${name}`,
    "",
    `| | before (${B.kbVersion}) | after (${A.kbVersion}) |`,
    "|---|---|---|",
    `| labels | ${cb.labels} | ${ca.labels} |`,
    `| scored | ${cb.scored} | ${ca.scored} |`,
    ...["coverage", "unknown_additive", "empty"].map((k) =>
      `| withheld: ${k} | ${cb.withheld[k] ?? 0} | ${ca.withheld[k] ?? 0} |`
    ),
    `| bands good / mid / low | ${cb.bands.good} / ${cb.bands.mid} / ${cb.bands.low} | ${ca.bands.good} / ${ca.bands.mid} / ${ca.bands.low} |`,
    "",
  );
  if (ca.scored < cb.scored) fails.push(`${name}: scored fell ${cb.scored} -> ${ca.scored}`);
  if (ca.scored > cb.scored) improvedSomewhere = true;

  for (const [code, rb] of b) {
    const ra = a.get(code);
    if (!ra) continue;
    if (rb.score !== null && ra.score === null) {
      fails.push(`${name} ${code} "${rb.name}": scored ${rb.score}, now withheld (${ra.withheld})`);
    } else if (rb.score !== null && ra.score !== rb.score) {
      warns.push(
        `${name} ${code} "${rb.name}": score ${rb.score} -> ${ra.score}; penalties ${
          JSON.stringify(rb.penalties)
        } -> ${JSON.stringify(ra.penalties)}`,
      );
    }
    for (const [path, x] of Object.entries(rb.items)) {
      const y = ra.items[path];
      if (x === y) continue;
      if (tick(x) && (!tick(y) || target(x) !== target(y ?? ""))) {
        fails.push(`${name} ${code} item ${path}: confident "${x}" -> "${y ?? "(gone)"}"`);
      } else if (!tick(x) && tick(y)) {
        const key = `${y.replace(/ (exact|variant|e_number|sub_phrase)@.*$/, " ($1)")}`;
        const e = newMatches.get(key) ?? { n: 0, eg: code };
        e.n++;
        newMatches.set(key, e);
      }
    }
    const oldJoined = new Set(rb.joined);
    for (const j of ra.joined) {
      if (!oldJoined.has(j)) {
        warns.push(`${name} ${code} joined item${ra.score !== null ? ` (scored ${ra.score})` : ""}: ${j}`);
      }
    }
  }
}
if (!improvedSomewhere) fails.push("no corpus scores more labels: the batch unlocks nothing");

const verdict = fails.length ? "FAIL" : "PASS";
const report = [
  `# KB corpus check: ${verdict}`,
  "",
  `Before: \`${B.dir}\` (${B.kbVersion}). After: \`${A.dir}\` (${A.kbVersion}).`,
  "",
  ...lines,
  `## Failures (${fails.length})`,
  "",
  ...(fails.length ? fails.map((f) => `- ${f}`) : ["None."]),
  "",
  `## Spot-check: warnings (${warns.length})`,
  "",
  ...(warns.length ? warns.map((w) => `- ${w}`) : ["None."]),
  "",
  `## Spot-check: newly confident matches (${newMatches.size} distinct)`,
  "",
  "Read each against the label: is the name really that ingredient, not a different food that shares a word?",
  "",
  ...[...newMatches].sort((x, y) => y[1].n - x[1].n).map(([k, v]) =>
    `- ${String(v.n).padStart(3)}× ${k} (e.g. ${v.eg})`
  ),
  "",
].join("\n");
await Deno.writeTextFile(`${out}/check.md`, report);
await Deno.writeTextFile(
  `${out}/check.json`,
  JSON.stringify(
    {
      verdict,
      before: B.kbVersion,
      after: A.kbVersion,
      summary,
      fails,
      warns,
      new_matches: Object.fromEntries(newMatches),
    },
    null,
    1,
  ),
);
console.log(
  `${verdict}: ${fails.length} failures, ${warns.length} warnings, ${newMatches.size} new matches -> ${out}/check.md`,
);
for (const c of corpora) {
  const s = summary[c] as { before: { scored: number; labels: number }; after: { scored: number } };
  console.log(
    `  ${c.replace(/^.*[\\/]/, "")}: scored ${s.before.scored} -> ${s.after.scored} of ${s.before.labels}`,
  );
}
if (fails.length) Deno.exit(1);
