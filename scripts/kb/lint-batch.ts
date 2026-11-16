// Mechanical checks on a knowledge-base batch branch in an ns-ingredients checkout, on top of `deno task
// kb:validate`: the rules in docs/CONTRIBUTING-KB.md that a schema cannot see.
//
//   deno run --allow-read --allow-run=git,deno [--allow-net=doi.org] scripts/kb/lint-batch.ts <dir> <base-ref> [--net]
//
// FAIL: kb/generated/ edited; a new entry not draft / ai-drafted or without Polish names and summary; an entry
// set to "reviewed"; a fact not graded A, an estimate graded A, an opinion above C; wording the rules forbid
// ("toxic", "szkodliwy"…); a new source with neither URL nor DOI; with --net, a DOI that doi.org does not know;
// kb:validate errors. WARN: files outside kb/ingredients and kb/sources; names removed from an entry; added names
// that are one generic word (wrong-merge risk); an additive with no assessment and no review_notes saying so.
import { parse } from "@std/yaml";

const [dir, base] = Deno.args.filter((a) => !a.startsWith("--"));
const net = Deno.args.includes("--net");
if (!dir || !base) throw new Error("usage: lint-batch.ts <ns-ingredients dir> <base-ref> [--net]");

const git = async (...args: string[]) => {
  const r = await new Deno.Command("git", { args: ["-C", dir, ...args], stdout: "piped", stderr: "piped" })
    .output();
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout);
};
const atBase = async (path: string) => {
  try {
    return parse(await git("show", `${base}:${path}`)) as Record<string, unknown>;
  } catch {
    return null;
  }
};
const fails: string[] = [], warns: string[] = [], notes: string[] = [];

// quotePath=false: git would otherwise print "kb/sources/\305\272r\303\263d\305\202a.yaml", which no filter matches.
const changed =
  (await git("-c", "core.quotePath=false", "diff", "--name-status", "--no-renames", `${base}...HEAD`))
    .trim().split("\n")
    .filter(Boolean).map((l) => l.split("\t") as [string, string]);
const FORBIDDEN =
  /\b(dangerous|toxic|harmful|poison\w*|niebezpieczn\w*|toksyczn\w*|szkodliw\w*|trując\w*|gefährlich\w*|giftig\w*|schädlich\w*)\b/iu;
const CLINICAL = /\b(safe for|unsafe for|safe in pregnancy|bezpieczn\w* dla|bezpieczn\w* w ciąży)\b/iu;
const GENERIC = new Set([
  "ekstrakt",
  "olej",
  "aromat",
  "aromaty",
  "proszek",
  "maka",
  "mąka",
  "skrobia",
  "syrop",
  "koncentrat",
  "przyprawa",
  "przyprawy",
  "sok",
  "białko",
  "bialko",
  "tłuszcz",
  "tluszcz",
  "extract",
  "oil",
  "flavouring",
  "powder",
  "flour",
  "starch",
  "syrup",
]);
const texts = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => texts(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => texts(x, out));
  return out;
};
const names = (ing: Record<string, unknown> | null) => {
  const out = new Set<string>();
  const n = (ing?.names ?? {}) as Record<string, string[]>;
  for (const list of Object.values(n)) for (const x of list ?? []) out.add(String(x));
  for (const v of (ing?.variants ?? []) as { names?: Record<string, string[]> }[]) {
    for (const list of Object.values(v.names ?? {})) for (const x of list ?? []) out.add(String(x));
  }
  return out;
};

const newSources: { id: string; url?: string; doi?: string; file: string }[] = [];
for (const [status, path] of changed) {
  if (path.startsWith("kb/generated/")) {
    fails.push(`${path}: kb/generated/ is machine-imported and never edited by hand`);
    continue;
  }
  // .yml too: the KB loader accepts both extensions, so neither may skip the batch checks.
  if (!/^kb\/(ingredients|sources)\/[^/]+\.ya?ml$/.test(path) && !/^kb\/sources\.ya?ml$/.test(path)) {
    warns.push(`${path} (${status}): outside a KB batch; needs its own review`);
    continue;
  }
  if (status === "D") {
    fails.push(`${path}: deleted`);
    continue;
  }
  const now = parse(await Deno.readTextFile(`${dir}/${path}`)) as Record<string, unknown>;
  const was = status === "A" ? null : await atBase(path);
  if (path.startsWith("kb/sources")) {
    type Cite = { id: string; url?: string; doi?: string; pmid?: string; accessed?: string };
    const old = new Map(((was?.sources ?? []) as Cite[]).map((s) => [s.id, s]));
    const cite = (s?: Cite) => s ? [s.doi ?? "", s.url ?? "", s.pmid ?? ""].join("|") : "";
    for (const s of (now.sources ?? []) as Cite[]) {
      // Unchanged existing sources were checked when they were added; new ones and changed citations are checked now.
      if (old.has(s.id) && cite(old.get(s.id)) === cite(s)) continue;
      if (!s.url && !s.doi) fails.push(`${path} source ${s.id}: neither url nor doi`);
      if (!s.accessed) warns.push(`${path} source ${s.id}: no accessed date`);
      newSources.push({ id: s.id, url: s.url, doi: s.doi, file: path });
    }
    continue;
  }
  const id = String(now.id);
  const where = `${path}${status === "A" ? " (new)" : ""}`;
  if (status === "A") {
    if (now.review_status !== "draft") fails.push(`${where}: review_status must be draft`);
    if (now.provenance !== "ai-drafted" && now.provenance !== "human") {
      fails.push(`${where}: provenance must be ai-drafted (or human)`);
    }
    const n = (now.names ?? {}) as Record<string, string[]>;
    if (!n.pl?.length) fails.push(`${where}: no names.pl`);
    if (!(now.summary as Record<string, string> | undefined)?.pl) fails.push(`${where}: no summary.pl`);
  } else if (now.review_status === "reviewed" && was?.review_status !== "reviewed") {
    fails.push(`${where}: set to reviewed; only a named human reviewer does that`);
  }
  for (const t of texts([now.summary, now.assertions, now.variants, now.regulatory])) {
    const m = t.match(FORBIDDEN);
    if (m) fails.push(`${where}: wording "${m[0]}" (rule 5: state the hazard, dose and population instead)`);
    const c = t.match(CLINICAL);
    if (c) warns.push(`${where}: clinical wording "${c[0]}" (rule 8)`);
  }
  const assertions = (now.assertions ?? []) as { code: string; kind: string; grade: string }[];
  for (const a of assertions) {
    if (a.kind === "fact" && a.grade !== "A") {
      fails.push(`${where} ${a.code}: a fact graded ${a.grade} (facts are A)`);
    }
    if (a.kind === "estimate" && a.grade === "A") fails.push(`${where} ${a.code}: an estimate graded A`);
    if (a.kind === "opinion" && !["C", "D"].includes(a.grade)) {
      fails.push(`${where} ${a.code}: an opinion graded ${a.grade} (C or D)`);
    }
  }
  const assessed = assertions.some((a) => a.code.startsWith("health.")) || !!now.regulatory;
  if ((now.type === "additive" || now.e_number) && !assessed && !(now.review_notes as unknown[])?.length) {
    warns.push(`${where}: additive with no assessment and no review_notes saying none was found`);
  }
  const before = names(was), after = names(now);
  const added = [...after].filter((x) => !before.has(x)), removed = [...before].filter((x) => !after.has(x));
  if (removed.length) warns.push(`${where}: names removed: ${removed.join(", ")}`);
  for (const x of added) {
    if (GENERIC.has(x.toLowerCase()) || x.trim().length < 3) {
      warns.push(`${where}: added name "${x}" is a generic word (wrong-merge risk)`);
    }
  }
  if (added.length) notes.push(`${id}${status === "A" ? " (new)" : ""}: +${added.join(" · ")}`);
}

if (net) {
  for (const s of newSources) {
    if (!s.doi) continue;
    const r = await fetch(`https://doi.org/api/handles/${encodeURIComponent(s.doi)}`);
    const body = r.ok ? await r.json() : (await r.body?.cancel(), null);
    if (!body || body.responseCode !== 1) {
      fails.push(`${s.file} source ${s.id}: doi.org does not know DOI ${s.doi}`);
    }
  }
}

const v = await new Deno.Command("deno", {
  args: ["run", "--allow-read", "scripts/kb-validate.ts"],
  cwd: dir,
  stdout: "piped",
  stderr: "piped",
}).output();
const vText = new TextDecoder().decode(v.stdout) + new TextDecoder().decode(v.stderr);
for (const l of vText.split("\n")) if (l.startsWith("ERROR")) fails.push(`kb:validate ${l}`);
// A validator that crashes (or exits nonzero for any reason) is a failure even when it printed no ERROR line.
if (v.code !== 0) {
  const tail = vText.trim().split("\n").slice(-3).join(" | ");
  fails.push(`kb:validate exited ${v.code}${tail ? `: ${tail}` : ""}`);
}
const vLine = vText.split("\n").find((l) => /^kb-[0-9a-f]+:/.test(l)) ?? "(kb:validate printed no summary)";

const verdict = fails.length ? "FAIL" : "PASS";
console.log(
  [
    `# KB batch lint: ${verdict}`,
    "",
    `${changed.length} files changed vs \`${base}\`; ${newSources.length} new sources. ${vLine}`,
    "",
    `## Failures (${fails.length})`,
    ...(fails.length ? fails.map((f) => `- ${f}`) : ["None."]),
    "",
    `## Warnings (${warns.length})`,
    ...(warns.length ? warns.map((w) => `- ${w}`) : ["None."]),
    "",
    `## Names added (check each is the same food, not a neighbour)`,
    ...(notes.length ? notes.map((n) => `- ${n}`) : ["None."]),
  ].join("\n"),
);
if (fails.length) Deno.exit(1);
