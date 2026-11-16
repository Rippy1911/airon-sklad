// Print how airon skład reads label strings: each item's match, coverage and the score (or why it is withheld).
// Use it to test names before committing them: "olej z pestek dyni", "sok pomarańczowy", "B12 i kwas pantotenowy".
//
//   deno run --allow-read scripts/kb/probe.ts "<label text>" ["<label text>" ...]
//   deno run --no-lock --config=<check out-dir>/after.deno.json --allow-read scripts/kb/probe.ts "…"
//
// The second form scores against another ns-ingredients checkout, through the import map scripts/kb/check.ts
// writes for its "after" side.
import { record } from "./dump.ts";

if (!Deno.args.length) throw new Error('usage: probe.ts "<label text>" [...]');
for (const [i, text] of Deno.args.entries()) {
  const r = record({ barcode: `probe-${i + 1}`, ingredients_text: text });
  console.log(`\n${text}`);
  console.log(
    `  ${r.score === null ? `withheld: ${r.withheld}` : `score ${r.score}`}; coverage ${r.coverage[0]}/${
      r.coverage[1]
    }`,
  );
  for (const [path, v] of Object.entries(r.items)) console.log(`  ${path.padEnd(6)} ${v}`);
  for (const p of r.penalties) console.log(`  penalty ${p}`);
  for (const j of r.joined) console.log(`  joined ${j}`);
}
