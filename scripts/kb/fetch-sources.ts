// Fetch the text of every source a KB batch adds, so a validator can check claims against what the source says
// without web access of its own.
//
//   deno run --allow-read --allow-run=git --allow-net --allow-write=<out-dir> scripts/kb/fetch-sources.ts \
//     <ns-ingredients dir> <base-ref> <out-dir>
//
// For a DOI: the Europe PMC record (title, journal, year, PMID, abstract), plus the open-access full text when
// the record has a PMCID; this is also how EFSA Journal opinions open when the publisher refuses the fetch. For a URL: the page with tags stripped (EUR-Lex documents
// are long; the validator searches them). Writes <out-dir>/<source id>.txt and <out-dir>/index.md, which also
// lists every PMID that Europe PMC does not give for that DOI.
import { parse } from "@std/yaml";

const [dir, base, out] = Deno.args;
if (!dir || !base || !out) {
  throw new Error("usage: fetch-sources.ts <ns-ingredients dir> <base-ref> <out-dir>");
}
const UA = "airon-sklad-kb-coverage/0.1 (open-source ingredient research)";
const git = async (...args: string[]) => {
  const r = await new Deno.Command("git", { args: ["-C", dir, ...args], stdout: "piped", stderr: "piped" })
    .output();
  return r.code === 0 ? new TextDecoder().decode(r.stdout) : "";
};
type Source = { id: string; title?: string; year?: number; url?: string; doi?: string; pmid?: string };
const files = (await git("-c", "core.quotePath=false", "diff", "--name-only", `${base}...HEAD`)).split("\n")
  .filter((f) => /^kb\/sources(\.ya?ml|\/[^/]+\.ya?ml)$/.test(f));
const fresh: Source[] = [];
for (const f of files) {
  const now = (parse(await Deno.readTextFile(`${dir}/${f}`)) as { sources?: Source[] }).sources ?? [];
  const before = new Map(
    ((parse((await git("show", `${base}:${f}`)) || "{}") as { sources?: Source[] } | null)?.sources ?? [])
      .map((s) => [s.id, [s.doi ?? "", s.url ?? "", s.pmid ?? ""].join("|")]),
  );
  // New sources, and existing ones whose citation changed.
  fresh.push(...now.filter((s) => before.get(s.id) !== [s.doi ?? "", s.url ?? "", s.pmid ?? ""].join("|")));
}

const strip = (html: string) =>
  html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n").trim();
async function get(url: string) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/json,*/*" } });
    const body = await r.text();
    return { ok: r.ok, status: r.status, url: r.url, body };
  } catch (e) {
    return { ok: false, status: 0, url, body: String(e) };
  }
}

/**
 * EUR-Lex pages sit behind a JavaScript robot check; the EU Publications Office's Cellar serves the same acts to
 * machines by CELEX number (content negotiation). ELI paths map to CELEX: reg|reg_impl|reg_del → R, dir → L,
 * dec|dec_impl → D.
 */
function cellar(url: string): string | null {
  const eli = url.match(/eur-lex\.europa\.eu\/eli\/(reg|reg_impl|reg_del|dir|dec|dec_impl)\/(\d{4})\/(\d+)/);
  if (eli) {
    const letter = eli[1].startsWith("dir") ? "L" : eli[1].startsWith("dec") ? "D" : "R";
    return `http://publications.europa.eu/resource/celex/3${eli[2]}${letter}${eli[3].padStart(4, "0")}`;
  }
  const celex = decodeURIComponent(url).match(/CELEX:([0-9A-Z()-]+)/i);
  return celex ? `http://publications.europa.eu/resource/celex/${celex[1]}` : null;
}

await Deno.mkdir(out, { recursive: true });
const rows: string[] = [], pmidIssues: string[] = [];
for (const s of fresh) {
  const parts: string[] = [`id: ${s.id}`, `cited title: ${s.title ?? ""}`, `cited year: ${s.year ?? ""}`];
  let status = "";
  if (s.doi) {
    const q = encodeURIComponent(`DOI:"${s.doi}"`);
    const r = await get(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${q}&resultType=core&format=json`,
    );
    const hit = r.ok ? JSON.parse(r.body).resultList?.result?.[0] : null;
    if (hit) {
      parts.push(
        `europepmc: ${hit.title}`,
        `journal: ${hit.journalInfo?.journal?.title ?? hit.bookOrReportDetails?.publisher ?? ""}, ${
          hit.pubYear ?? ""
        }`,
        `pmid: ${hit.pmid ?? "(none)"}  pmcid: ${hit.pmcid ?? "(none)"}  doi: ${hit.doi ?? ""}`,
        "",
        "abstract:",
        strip(hit.abstractText ?? "(no abstract in Europe PMC)"),
      );
      status = `Europe PMC ${hit.pmid ? `PMID ${hit.pmid}` : "no PMID"}`;
      if (hit.pmcid) {
        const ft = await get(`https://www.ebi.ac.uk/europepmc/webservices/rest/${hit.pmcid}/fullTextXML`);
        if (ft.ok && ft.body.length > 500) {
          const text = strip(ft.body);
          parts.push("", `full text (${hit.pmcid}, Europe PMC open access):`, text);
          status += `, full text ${text.length} chars`;
        } else status += ", abstract only";
      } else status += ", abstract only";
      if (s.pmid && hit.pmid && String(s.pmid) !== String(hit.pmid)) {
        pmidIssues.push(`${s.id}: cites PMID ${s.pmid}, Europe PMC gives ${hit.pmid} for DOI ${s.doi}`);
      } else if (s.pmid && !hit.pmid) {
        pmidIssues.push(`${s.id}: cites PMID ${s.pmid}, Europe PMC has none for the DOI`);
      }
    } else {
      status = `Europe PMC: no record (HTTP ${r.status})`;
      if (s.pmid) {
        pmidIssues.push(`${s.id}: cites PMID ${s.pmid}, but Europe PMC has no record for DOI ${s.doi}`);
      }
    }
  }
  if (s.url && !(s.doi && status.startsWith("Europe PMC PMID"))) {
    const alt = cellar(s.url);
    const r = alt
      ? await fetch(alt, {
        headers: { "User-Agent": UA, Accept: "application/xhtml+xml, text/html", "Accept-Language": "en" },
      }).then(async (x) => ({ ok: x.ok, status: x.status, url: x.url, body: await x.text() }))
        .catch((e) => ({ ok: false, status: 0, url: alt, body: String(e) }))
      : await get(s.url);
    const text = /json/.test(r.body.slice(0, 1)) ? r.body : strip(r.body);
    parts.push("", `fetched: ${s.url} -> HTTP ${r.status} ${r.url}`, "", text);
    status += `${status ? "; " : ""}URL HTTP ${r.status}, ${text.length} chars`;
  }
  await Deno.writeTextFile(`${out}/${s.id}.txt`, parts.join("\n"));
  rows.push(`| ${s.id} | ${status} | ${s.id}.txt |`);
  await new Promise((r) => setTimeout(r, 300));
}
await Deno.writeTextFile(
  `${out}/index.md`,
  [
    `# Source texts for ${fresh.length} new sources (fetched ${new Date().toISOString()})`,
    "",
    "| id | fetched | file |",
    "|---|---|---|",
    ...rows,
    "",
    `## PMID mismatches (${pmidIssues.length})`,
    ...(pmidIssues.length ? pmidIssues.map((p) => `- ${p}`) : ["None."]),
    "",
  ].join("\n"),
);
console.log(`${fresh.length} sources -> ${out}/index.md; ${pmidIssues.length} PMID mismatches`);
