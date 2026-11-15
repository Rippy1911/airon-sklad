# airon skład

**Sprawdź skład, zanim włożysz do koszyka.** A site that reads the ingredient list of a food sold in Poland
and explains it: allergens, additives, and a score from 0 to 100 under open, versioned rules, with the reason
and source for every deduction.

Status: **beta, rules v0.1 (draft)**. Live at <https://sklad.airon.app>, not indexed by search engines yet.

## How it works

```
EAN ──► ns-food ──(miss, 429, 5xx, timeout)──► Open Food Facts ──► ingredient text
                                                                       │
photo(s) ──► Claude Haiku (transcribes only) ──► you confirm the text ─┤
                                                                       ▼
                         ns-ingredients analyser (vendor/) ──► rules/v0.1.json ──► score + description
```

- **Data.** Products come from [ns-food](https://food.nextsolutions.studio) first, which serves
  [Open Food Facts](https://world.openfoodfacts.org) data. When ns-food is rate-limited, down, slow (2.5 s) or
  does not have the code, the site asks Open Food Facts directly. Each page says which source answered and when.
- **Photos.** Up to four photos (front and back). A model only transcribes the label; the person checks and
  edits the text, and only then is it rated. Photos and text are not stored. Reading is capped per day.
- **Analysis.** [ns-ingredients](https://github.com/NextSolutionsStudio/ns-ingredients) parses the list,
  matches each item against its knowledge base and attaches graded, sourced facts.
- **Score.** Deterministic: start at 100, subtract a fixed weight per group of ingredients
  ([rules/v0.1.json](rules/v0.1.json), explained on `/jak-liczymy`). A deduction counts only for an item matched
  with confidence (exact name, variant or E-number; never a fuzzy match) and a trigger the analyser marks
  certain. No score is given when there is no list, when under 80% of items are confidently recognised, or when
  an additive cannot be identified.

## Routes

| Route | What |
|---|---|
| `/` · `/szukaj?q=` | search by name or EAN |
| `/p/{ean}` | product: score, allergens, diets, the list as printed, deductions, nutrition, provenance |
| `/skladnik/{id}` | one ingredient from the knowledge base, with evidence grades and sources |
| `/zdjecie` | photo or typed list → confirmation → `/ocen` |
| `/jak-liczymy` · `/o-danych` | the rules; data sources and licences |
| `GET /api/product/{ean}` | JSON: product, score, description, full analysis, licence metadata |
| `POST /api/analyze` | JSON `{"text": "…"}` (≤ 5000 chars) → the same analysis for any list |

All routes are rate-limited per IP (IPv6 per /64).

## Run it

Requires Deno 2 and Node 22 (wrangler and the fonts only).

```sh
git clone --recurse-submodules https://github.com/Rippy1911/airon-sklad
cd airon-sklad
npm ci
deno task test     # unit and route tests, no network
deno task build    # knowledge-base bundle, fonts, dist/worker.js
npx wrangler d1 migrations apply airon-sklad --local
npx wrangler dev
```

Without keys the site runs on Open Food Facts alone and photo reading is off. With keys, put `NS_FOOD_KEY` and
`ANTHROPIC_API_KEY` in `.dev.vars` (git-ignored), or see `scripts/dev.mjs`.

## Deploy

Cloudflare Workers with Static Assets, D1 (the photo budget) and two rate-limit bindings; see `wrangler.jsonc`.
Secrets: `NS_FOOD_KEY` (read-only ns-food key) and `ANTHROPIC_API_KEY`.

```sh
npx wrangler d1 migrations apply airon-sklad --remote
deno task build && npx wrangler deploy
```

## Licences

Code: **AGPL-3.0** (LICENSE). Rules: **CC BY-SA 4.0**. Includes ns-ingredients under its own terms, whose
attribution ("Powered by ns-ingredients (NextSolutions)") must be kept. Product data: Open Food Facts, **ODbL
1.0**. Details in [NOTICE](NOTICE).

This is an assessment of an ingredient list, not medical or dietary advice and not a product review.
