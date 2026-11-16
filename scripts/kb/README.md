# Knowledge-base batches: how coverage grows

airon skład scores a label only when at least 80% of its items match the ns-ingredients knowledge base with
confidence and no additive is unidentified (`src/score.ts`). So the knowledge base decides how many products
get a score. These scripts find what the KB is missing on real labels, and gate every KB change on what it
does to real scores. The KB rules themselves are in `vendor/ns-ingredients/docs/CONTRIBUTING-KB.md`.

| Script                                                           | Does                                                                                                                                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `popular.ts <out.json> [target] [max_codes]`                     | The most-scanned products sold in Poland (Open Food Facts `unique_scans_n`) that have a Polish ingredient list. Read-only, about 90 requests a minute, resumable.                                   |
| `dump.ts <corpus.json> <out.json>`                               | Scores every label with this repo's own rules and records each item's match, the score or why it is withheld, and "joined items".                                                                   |
| `gaps.ts <out-dir> <dump> <corpus> […]`                          | Ranks the items that hold labels back from a score: `gaps.json` (all) and `job.md` (the top items with label context for the drafter, then the parser-shaped items, which are not the KB's to fix). |
| `lint-batch.ts <ns-ingredients dir> <base-ref> [--net]`          | The contributing rules a schema cannot check, on a batch branch's diff, plus `kb:validate`. With `--net`, every new DOI must resolve.                                                               |
| `check.ts --before <dir> --after <dir> --out <dir> <corpus> […]` | The corpus gate. Scores the corpora against two ns-ingredients checkouts and compares them.                                                                                                         |
| `fetch-sources.ts <ns-ingredients dir> <base-ref> <out-dir>` | The text of every source a batch adds (Europe PMC record by DOI; EU acts from the Publications Office's Cellar, since EUR-Lex pages need JavaScript), so a validator without web access checks claims against what the source says. |

`dump.ts` and `gaps.ts` read `vendor/ns-ingredients`. `check.ts` points that path at any checkout through an
import map, so this repo's scoring code always runs unmodified.

## One batch

1. **Corpus.** Fetch the popular products and keep them next to the fixed 600-label sample, so every batch is
   measured on the same labels.
2. **Gaps.** `dump.ts` on each corpus, then `gaps.ts` over all of them. The job is the top KB items of
   `job.md`.
3. **Draft.** On a branch of ns-ingredients cut from `main`, the drafting lane (an AI model) maps the job's
   items by the contributing rules. Each item ends up as a Polish name on an existing entry, a new
   identity-only entry, a new entry with an assessment it actually opened, or a skip with a reason. All of it
   is `review_status: draft`, `provenance: ai-drafted`.
4. **Mechanical gates.** `lint-batch.ts --net` and `check.ts` must both PASS. `check.ts` fails when a corpus
   scores fewer labels, when a label that scored is withheld, or when a confidently matched item loses its
   match or changes ingredient. It also fails when no corpus scores more.
5. **Gate 1: validation** by a second model that did not draft. It reads every new source's text (`fetch-sources.ts`)
   and confirms that the source says what is claimed. It reads every added name and every newly confident match against the
   label text, looking for wrong merges.
6. **Gate 2: review** of the pull request by a third model.
7. **Merge.** Squash-merge into ns-ingredients `main` once both gates are READY and CI is green. Then bump
   `vendor/ns-ingredients` here, run `deno task test`, re-measure with `scripts/measure.ts`, and deploy.

A lane never reviews its own batch. Any fix round sends the new head back through the gates it changed.
