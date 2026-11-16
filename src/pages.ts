/** Every page, in Polish. Data reaches markup only through `html`, which escapes it. */
import { COMMIT } from "./build-info.ts";
import { type Lookup, type Nutrients, type Product, type SearchHit, sized } from "./data/product.ts";
import { allergens, describe, diets } from "./describe.ts";
import { type AnalysisResult, flatItems, type ItemResult, kb } from "./engine.ts";
import { ENGINE_REPO, fmtNum, type Html, html, icon, page, REPO, trusted } from "./html.ts";
import { MAX_PHOTOS, PHOTO_ERROR_PL, type PhotoError } from "./photo.ts";
import { isConfident, RULES, type Score } from "./score.ts";

const GRADE_PL: Record<string, string> = {
  A: "decyzja regulatora",
  B: "przegląd systematyczny lub metaanaliza",
  C: "badania kliniczne lub spójne badania obserwacyjne",
  D: "mechanizm, badania na zwierzętach, opisy przypadków, opinia ekspertów",
};
const KIND_PL: Record<string, string> = { fact: "Fakt", estimate: "Szacunek", opinion: "Opinia" };
const STATUS_CLASS: Record<string, string> = { yes: "yes", no: "no", maybe: "maybe", unknown: "unknown" };

const grade = (g: string, kind = "") =>
  html`<span class="grade g-${g}" title="${`Dowód ${g}: ${GRADE_PL[g] ?? ""}`}">${
    kind ? `${KIND_PL[kind] ?? kind} ` : "Dowód "
  }${g}</span>`;

const today = () => new Date().toISOString().slice(0, 10);
const pl = (t: { en: string; pl?: string } | undefined) => t?.pl ?? t?.en ?? "";

// ---------- shared blocks ----------

function ruler(score: number): Html {
  const x = Math.min(99.2, Math.max(0.8, score));
  return html`
    <div class="ruler" role="img" aria-label="${`Skala 0–100: słaby poniżej 50, do przemyślenia 50–79, dobry od 80. Ten skład: ${score}.`}">
      <svg viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true">
        <rect x="0" y="3" width="50" height="8" fill="#F3D9D5"></rect>
        <rect x="50" y="3" width="30" height="8" fill="#F5E6C8"></rect>
        <rect x="80" y="3" width="20" height="8" fill="#D4E8DC"></rect>
        <rect x="${x - 0.6}" y="0" width="1.2" height="14" fill="#16181B"></rect>
      </svg>
      <div
        class="ruler-legend"><span>0 · słaby</span><span>50 · do przemyślenia</span><span>80 · dobry</span></div>
    </div>
  `;
}

function coverage(s: Score): Html {
  const { total, confident } = s.coverage;
  const cells = total && total <= 40
    ? html`<div class="cells" aria-hidden="true">${
      Array.from(
        { length: total },
        (_, i) => html`<span class="${i < confident ? "cell on" : "cell"}"></span>`,
      )
    }</div>`
    : "";
  return html`
    <div
      class="coverage">${cells}<span><strong>Rozpoznaliśmy pewnie ${confident} z ${total} składników.</strong> Wynik wystawiamy od ${Math
        .round(RULES.coverage_min * 100)}% pewnego rozpoznania.</span></div>
  `;
}

/** Polish agreement: 1 grupa, 2–4 grupy, 5+ grup (12–14 too). */
export function groupsPl(n: number): string {
  if (n === 1) return "wpływa jedna grupa";
  const few = n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14);
  return few ? `wpływają ${n} grupy` : `wpływa ${n} grup`;
}

function scoreCard(s: Score): Html {
  if (s.score === null) {
    const w = s.withheld!;
    const msg = w.reason === "empty"
      ? "Nie ma listy składników, więc nie ma wyniku."
      : w.reason === "coverage"
      ? "Rozpoznaliśmy za mało składu, by go uczciwie ocenić."
      : html`Nie rozpoznaliśmy ${
        w.detail.length === 1 ? "dodatku, który może" : "dodatków, które mogą"
      } zmienić wynik: <strong>${w.detail.join(", ")}</strong>.`;
    return html`<div class="card score band-none">
  <div class="score-row">
    <div class="score-num"><span class="num">—</span><span class="of">/100</span></div>
    <div class="score-side"><span class="band-label">Bez wyniku</span><span class="chip-beta">reguły v${s.version} robocze</span></div>
  </div>
  <p>${msg} Wolimy nie wystawić wyniku niż wystawić zły. <a href="/jak-liczymy#bez-wyniku">Kiedy nie ma wyniku</a></p>
  ${s.coverage.total ? coverage(s) : ""}
</div>`;
  }
  const summary = s.penalties.length
    ? html`Na wynik ${groupsPl(s.penalties.length)} składników: ${
      s.penalties.map((p, i) => html`${i ? ", " : ""}<strong>${p.label.toLowerCase()}</strong> −${p.weight}`)
    }.`
    : "Nic w składzie nie obniża wyniku według reguł v0.1.";
  return html`<div class="card score band-${s.band!.id}">
  <div class="score-row">
    <div class="score-num"><span class="num">${s.score}</span><span class="of">/100</span></div>
    <div class="score-side"><span class="band-label">${
    s.band!.label
  }</span><span class="chip-beta">reguły v${s.version} robocze</span></div>
  </div>
  ${ruler(s.score)}
  <p>${summary}</p>
  ${coverage(s)}
</div>`;
}

function allergenCard(a: AnalysisResult, tracesTags: string[] = []): Html {
  const al = allergens(a);
  const may = a.may_contain.map((m) => m.text);
  const traces = tracesTags.length && !may.length
    ? tracesTags.map((t) => t.replace(/^[a-z]{2}:/, "").replace(/-/g, " "))
    : [];
  return html`<div class="card mini">
  <h2 class="eyebrow">Alergeny</h2>
  ${
    al.sure.length
      ? html`<div class="pills">${al.sure.map((x) => html`<span class="pill dark">${x}</span>`)}</div>`
      : html`<p>Nie znaleźliśmy w składzie żadnego z 14 alergenów UE.</p>`
  }
  ${
    al.possible.length
      ? html`<p class="small">Możliwe, do sprawdzenia na opakowaniu: ${al.possible.join(", ")}.</p>`
      : ""
  }
  <p class="small muted">Może zawierać: ${
    may.length
      ? may.join("; ").replace(/[.s]+$/, "")
      : traces.length
      ? `${traces.join(", ")} (z Open Food Facts)`
      : "producent nie podał"
  }. Źródło: rozporządzenie (UE) 1169/2011, załącznik II.</p>
</div>`;
}

function dietCard(a: AnalysisResult): Html {
  return html`
    <div class="card mini">
      <h2 class="eyebrow">Dla kogo</h2>
      <div class="diets">${diets(a).map((d) =>
        html`<span class="diet"><span class="${`mark ${
          STATUS_CLASS[d.status] ?? "unknown"
        }`}">${d.mark.toUpperCase()}</span>${d.name}</span>`
      )}</div>
      <p
        class="small muted">Na podstawie składu z etykiety. Przy alergii lub celiakii zawsze czytaj opakowanie.</p>
    </div>
  `;
}

function chips(a: AnalysisResult, s: Score): Html {
  const penalised = new Set(s.penalties.flatMap((p) => p.items.map((i) => i.path)));
  const allergenPaths = new Set(
    a.flags.filter((f) => f.code.startsWith("allergen."))
      .flatMap((f) =>
        f.triggers.filter((t) => t.certainty === "yes" && t.basis !== "trace").map((t) => t.path)
      ),
  );
  const kindOf = (it: ItemResult) => {
    if (penalised.has(it.path)) return "ing pen";
    if (it.emphasized.length || allergenPaths.has(it.path)) return "ing alg";
    if (!it.children.length && it.role !== "qualifier" && !isConfident(it.match)) return "ing unk";
    return "ing";
  };
  const extra = (it: ItemResult) => it.percent?.raw ?? it.match?.e_number ?? "";
  const chip = (it: ItemResult, pos: string) => {
    const inner = html`${pos ? html`<span class="pos">${pos}</span>` : ""}<span class="nm">${it.name}</span>${
      extra(it) ? html`<span class="ex">${extra(it)}</span>` : ""
    }`;
    return isConfident(it.match)
      ? html`<a class="${kindOf(it)}" href="${`/skladnik/${it.match!.ingredient_id}`}">${inner}</a>`
      : html`<span class="${kindOf(it)}">${inner}</span>`;
  };
  const sub = (it: ItemResult): Html | string => {
    const kids = it.children.filter((c) => c.role !== "qualifier");
    return kids.length
      ? html`<span class="sub">${kids.map((c) => html`${chip(c, "")}${sub(c)}`)}</span>`
      : "";
  };
  return html`<ol class="chips">${
    a.items.filter((it) => it.role !== "qualifier").map((it, i) =>
      html`<li>${chip(it, String(i + 1))}${sub(it)}</li>`
    )
  }</ol>
<div class="legend">
  <span><i class="sw pen"></i>obniża wynik</span>
  <span><i class="sw alg"></i>alergen (wyróżniony na etykiecie)</span>
  <span><i class="sw unk"></i>nie rozpoznaliśmy pewnie</span>
  <span><i class="sw"></i>bez wpływu</span>
</div>`;
}

function penaltyBlocks(s: Score): Html {
  if (s.score === null) {
    return html`<p class="muted">Bez wyniku nie liczymy kar. Poniżej to, co już widać w składzie.</p>${
      possibleList(s, true)
    }`;
  }
  if (!s.penalties.length) {
    return html`<p>Nic w składzie nie obniża wyniku według reguł v${s.version}.</p>${possibleList(s)}`;
  }
  return html`${
    s.penalties.map((p) =>
      html`
        <div class="pen-card">
          <div
            class="pen-head"><h3>${p.label}</h3><span class="pen-w">−${p
              .weight} <small>waga robocza</small></span></div>
          <div class="pen-items">${p.items.map((i) =>
            html`<div class="pen-item"><b>${i.name}</b><span>${i.position}. miejsce</span></div>`
          )}</div>
          <p>${p.why}</p>
          <div class="pen-src">${grade(p.grade)}${p.sources.slice(0, 3).map((src) =>
            src.url
              ? html`<a href="${src.url}" rel="noopener">${src.title}</a>`
              : html`<span>${src.title}</span>`
          )}</div>
        </div>
      `
    )
  }${possibleList(s)}`;
}

function possibleList(s: Score, all = false): Html | string {
  const rows = [
    ...s.possible.map((p) => ({
      name: p.label,
      why: `możliwe w: ${p.items.join(", ")}; nie liczymy bez pewności`,
    })),
    ...(all ? s.penalties.map((p) => ({ name: p.label, why: p.items.map((i) => i.name).join(", ") })) : []),
    ...s.unassessed.map((u) => ({
      name: u,
      why: "znamy tylko z nazwy, bez oceny w bazie: nie obniża wyniku",
    })),
  ];
  if (!rows.length) return "";
  return html`<h3 class="h-sm">Nie liczymy do wyniku</h3>
<div class="rows">${
    rows.map((r) =>
      html`<div class="row"><span class="b">${r.name}</span><span class="muted">${r.why}</span></div>`
    )
  }</div>`;
}

/** How an ingredient is made or what it comes from, in the order the card lists them: plain plant origin last. */
const ORIGIN_ORDER = [
  "origin.vegetable_oil_derived",
  "ethics.palm_oil",
  "origin.microbial_fermentation",
  "origin.chemical_synthesis",
  "origin.petrochemical_synthetic",
  "origin.mineral",
  "origin.animal",
  "origin.fish",
  "origin.insect",
  "origin.dairy",
  "origin.egg",
  "origin.bee_product",
  "origin.gmo_derived",
  "origin.plant",
];
const isOrigin = (code: string) => ORIGIN_ORDER.includes(code);
const seen = (c: string) => c === "yes" || c === "maybe";
// A constant, not an html`` template: deno fmt reflows those, and the reflowed whitespace renders as a space
// before the next comma ("cukier (możliwe) , olej").
const MAYBE = trusted(' <span class="muted">(możliwe)</span>');

/** Every origin flag, with the items behind it and the knowledge base's note on how each is made. */
export function originsCard(a: AnalysisResult): Html | string {
  const flags = a.flags.filter((f) => isOrigin(f.code) && seen(f.certainty))
    .sort((x, y) => ORIGIN_ORDER.indexOf(x.code) - ORIGIN_ORDER.indexOf(y.code));
  if (!flags.length) return "";
  const byPath = new Map(flatItems(a.items).map((it) => [it.path, it.name]));
  return html`
    <section class="card">
      <div
        class="sec-head"><h2 class="h2">Skąd pochodzą składniki</h2><span class="muted small">Z czego i jak się je wytwarza, według bazy składników. Nie zmienia wyniku.</span></div>
      <div class="origins">${flags.map((f) => {
        const items = new Map<string, string>(); // item name -> surest certainty
        const notes = new Map<string, string[]>(); // note -> the items it explains
        for (const t of f.triggers.filter((t) => seen(t.certainty))) {
          const name = byPath.get(t.path);
          if (!name) continue;
          if (items.get(name) !== "yes") items.set(name, t.certainty);
          if (t.note && !notes.get(t.note)?.includes(name)) {
            notes.set(t.note, [...notes.get(t.note) ?? [], name]);
          }
        }
        return html`<div class="fact">
  <div class="fact-head">${grade(f.grade, f.kind)}<b>${f.label}</b></div>
  <p class="small">${
          [...items].map(([name, c], i) => html`${i ? ", " : ""}${name}${c === "yes" ? "" : MAYBE}`)
        }</p>
  ${
          notes.size
            ? html`<details class="raw"><summary>Jak to wiemy</summary>${
              [...notes].map(([note, names]) => html`<p><b>${names.join(", ")}:</b> ${note}</p>`)
            }</details>`
            : ""
        }
</div>`;
      })}</div>
    </section>
  `;
}

function worthKnowing(a: AnalysisResult): Html | string {
  const counted = new Set(RULES.groups.flatMap((g) => g.codes));
  const flags = a.flags
    .filter((f) =>
      !f.code.startsWith("allergen.") && !counted.has(f.code) && !isOrigin(f.code) &&
      (f.certainty === "yes" || f.certainty === "maybe")
    )
    .sort((x, y) => (x.certainty === "yes" ? 0 : 1) - (y.certainty === "yes" ? 0 : 1))
    .slice(0, 6);
  if (!flags.length) return "";
  const byPath = new Map(flatItems(a.items).map((it) => [it.path, it.name]));
  return html`<div class="card">
  <h2 class="h2">Warto wiedzieć</h2>
  ${
    flags.map((f) => {
      const names = [...new Set(f.triggers.map((t) => byPath.get(t.path)).filter(Boolean))].join(", ");
      const note = f.triggers.find((t) => t.note)?.note ?? "";
      return html`
        <div class="fact">
          <div class="fact-head">${grade(f.grade, f.kind)}<b>${f.label}</b>${f.certainty === "maybe"
            ? html`<span class="muted small">możliwe</span>`
            : ""}</div>
          <p class="small">${names ? `${names}. ` : ""}${note}</p>
        </div>
      `;
    })
  }
  <p class="small muted">Te informacje nie zmieniają wyniku.</p>
</div>`;
}

function nutritionCard(n: Nutrients, zeroMayBeMissing: boolean): Html | string {
  const rows: [string, number | null, string, boolean][] = [
    ["Wartość energetyczna", n.kcal, "kcal", false],
    ["Tłuszcz", n.fat, "g", false],
    ["w tym nasycone", n.satfat, "g", true],
    ["Węglowodany", n.carbs, "g", false],
    ["w tym cukry", n.sugars, "g", true],
    ["Błonnik", n.fiber, "g", false],
    ["Białko", n.protein, "g", false],
    ["Sól", n.salt, "g", false],
  ];
  if (rows.every((r) => r[1] === null)) return "";
  const cell = (v: number | null, unit: string) =>
    v === null
      ? html`<span class="muted">—</span>`
      : v === 0 && zeroMayBeMissing
      ? html`0 ${unit} <span class="check" title="Źródło zapisuje brak wartości jako 0">sprawdź</span>`
      : `${fmtNum(v)} ${unit}`;
  return html`
    <div class="card">
      <h2 class="h2">Wartości odżywcze w 100 g</h2>
      <table class="nutr">
        <tbody>${rows.map(([name, v, unit, indent]) =>
          html`
            <tr>
              <td class="${indent ? "ind" : ""}">${name}</td>
              <td class="v">${cell(v, unit)}</td>
            </tr>
          `
        )}</tbody>
      </table>
      <p
        class="small muted">Z bazy produktów, w 100 g (u napojów zwykle w 100 ml). Nie wliczamy ich do wyniku składu.</p>
    </div>
  `;
}

function analysisSections(
  a: AnalysisResult,
  s: Score,
  ingredientsText: string,
  n?: { nutrients: Nutrients; zero: boolean },
): Html {
  return html`<section class="card">
  <div class="sec-head"><h2 class="h2">Skład, tak jak na etykiecie</h2><span class="muted small">Kolejność to ilość: pierwszego składnika jest najwięcej.</span></div>
  ${a.items.length ? chips(a, s) : ""}
  <details class="raw"><summary>Pełny tekst składu</summary><p>${ingredientsText}</p></details>
</section>
<section class="split">
  <div class="card grow3">
    <h2 class="h2">Co obniża wynik</h2>
    ${penaltyBlocks(s)}
  </div>
  <div class="stack grow2">
    ${n ? nutritionCard(n.nutrients, n.zero) : ""}
    ${worthKnowing(a)}
    <div class="card">
      <h2 class="h2">W skrócie</h2>
      <ul class="plain">${describe(a, s).map((line) => html`<li>${line}</li>`)}</ul>
    </div>
  </div>
</section>
${originsCard(a)}`;
}

// ---------- pages ----------

export function homePage(): Html {
  return page({
    title: "Sprawdź skład produktu",
    description:
      "Wpisz nazwę lub kod EAN albo zrób zdjęcie etykiety: pokażemy skład, alergeny i wynik według otwartych reguł.",
    main: html`
      <section class="hero-home">
        <h1 class="display">Sprawdź skład, zanim włożysz do koszyka</h1>
        <p
          class="lead">Wpisz nazwę albo kod EAN. Pokażemy skład z etykiety, alergeny i wynik od 0 do 100 według otwartych reguł, ze źródłem przy każdej karze.</p>
        <form class="search big" action="/szukaj" method="get" role="search">
          ${icon.search}<label class="sr" for="q2">Szukaj produktu</label>
          <input id="q2" name="q" type="search" placeholder="np. biszkopty albo 5900672001082" autocomplete="off" required minlength="2">
          <button class="btn primary" type="submit">Szukaj</button>
        </form>
        <a class="btn ghost" href="/zdjecie">${icon.camera} Nie ma w bazie? Zrób zdjęcie składu</a>
      </section>
      <section class="three">
        <div class="card">
          <h2 class="h3">Skład z etykiety</h2>
          <p>Dane z Open Food Facts przez ns-food. Każdy składnik rozpoznajemy w otwartej bazie i linkujemy do opisu ze źródłami.</p>
        </div>
        <div class="card">
          <h2 class="h3">Wynik, który da się sprawdzić</h2>
          <p>Zaczynamy od 100 i odejmujemy za grupy składników. Każda kara ma wagę, powód i źródło. Reguły są publiczne.</p>
        </div>
        <div class="card">
          <h2 class="h3">Bez zgadywania</h2>
          <p>Gdy nie rozpoznamy dodatku albo zbyt dużej części składu, nie wystawiamy wyniku. Mówimy wtedy, czego brakuje.</p>
        </div>
      </section>
    `,
  });
}

export function searchPage(q: string, r: { hits: SearchHit[]; source: string | null; why?: string }): Html {
  const src = r.source === "ns-food" ? "z bazy ns-food" : r.source === "off" ? "z Open Food Facts" : "";
  return page({
    title: q ? `Szukaj: ${q}` : "Szukaj",
    q,
    main: html`<h1 class="h1">Wyniki dla „${q}”</h1>
${
      r.hits.length
        ? html`<p class="muted small">${r.hits.length} ${
          r.hits.length === 1 ? "produkt" : "produktów"
        } ${src}.</p>
<ul class="results">${
          r.hits.map((h) =>
            html`<li><a class="card result" href="${`/p/${h.ean}`}">${html`<img src="${
              h.imageUrl ? sized(h.imageUrl, 200) : `/img/${h.ean}`
            }" alt="" loading="lazy" decoding="async" width="64" height="64">`}<span><b>${h.name}</b><span class="mono muted">${
              h.brand ? `${h.brand} · ` : ""
            }EAN ${h.ean}</span></span></a></li>`
          )
        }</ul>`
        : html`
          <div class="card">
            <p>${r.why
              ? "Wyszukiwanie jest chwilowo niedostępne. Spróbuj za chwilę albo wpisz kod EAN."
              : "Nic nie znaleźliśmy."}</p>
            <p><a href="/zdjecie">Zrób zdjęcie składu</a>, a ocenimy go bez bazy.</p>
          </div>
        `
    }`,
  });
}

function productHero(p: Product, right: Html): Html {
  return html`<section class="hero">
  <figure class="card pack">
    <div class="pack-img">${
    p.imageUrl
      ? html`<img src="${sized(p.imageUrl, 400)}" alt="${`Opakowanie: ${p.name}`}" width="360" height="360">`
      : icon.pack
  }</div>
    ${
    p.imageUrl
      ? html`<figcaption class="small muted">Zdjęcie: Open Food Facts, CC BY-SA 3.0</figcaption>`
      : ""
  }
  </figure>
  <div class="hero-main">
    <div class="titles">
      <span class="eyebrow mono">${[p.brand, p.quantity].filter(Boolean).join(" · ") || "Produkt"}</span>
      <h1 class="display">${p.name}</h1>
      <span class="mono muted">EAN ${p.ean}</span>
    </div>
    ${right}
  </div>
</section>`;
}

function provenance(p: Product, fellBack: boolean, why?: string): Html {
  const src = p.source === "ns-food" ? "ns-food (z Open Food Facts)" : "Open Food Facts";
  return html`
    <section class="prov">
      <h2 class="h2">Skąd te dane</h2>
      <div class="prov-grid">
        <div><span>Źródło</span><b>${src}</b>${fellBack
          ? html`<small>${
            why === "not in ns-food" ? "ns-food nie ma tego kodu" : "ns-food chwilowo nie odpowiada"
          }</small>`
          : ""}</div>
        ${p.offModified
          ? html`<div><span>Etykieta zmieniona w Open Food Facts</span><b class="mono">${p.offModified}</b></div>`
          : ""}
        <div><span>Pobrane przez nas</span><b class="mono">${p.fetchedAt.slice(0, 10)}</b></div>
        <div><span>Ocenione</span><b class="mono">${today()} · reguły v${RULES.version}</b></div>
      </div>
      <div class="prov-links">
        <a class="btn light" href="${`https://world.openfoodfacts.org/product/${p.ean}`}" rel="noopener">Popraw w Open Food Facts</a>
        <a class="btn outline" href="/jak-liczymy">Jak liczymy wynik</a>
        <a class="btn outline" href="${`/api/product/${p.ean}`}">Dane JSON</a>
      </div>
      <p
        class="small">Zawiera dane z Open Food Facts (ODbL). Reguły wyniku: CC BY-SA 4.0. To ocena składu z etykiety, nie porada medyczna i nie recenzja produktu.</p>
    </section>
  `;
}

export function productPage(
  l: Extract<Lookup, { status: "found" }>,
  a: AnalysisResult | null,
  s: Score | null,
): Html {
  const p = l.product;
  if (!a || !s || !p.ingredientsText) return noIngredientsPage(l);
  return page({
    title: `${p.name}: skład i wynik`,
    description: `Skład ${p.name}${p.brand ? ` (${p.brand})` : ""}: alergeny, dodatki i wynik ${
      s.score ?? "bez wyniku"
    } według otwartych reguł.`,
    main: html`${
      productHero(
        p,
        html`${scoreCard(s)}<div class="duo">${allergenCard(a, p.tracesTags)}${dietCard(a)}</div>`,
      )
    }
${analysisSections(a, s, p.ingredientsText, { nutrients: p.nutrients, zero: p.zeroMayBeMissing })}
${provenance(p, l.fellBack, l.why)}`,
  });
}

function noIngredientsPage(l: Extract<Lookup, { status: "found" }>): Html {
  const p = l.product;
  return page({
    title: `${p.name}: brak składu`,
    main: html`${
      productHero(
        p,
        html`
          <div class="card score band-none">
            <div class="score-row">
              <div class="score-num"><span class="num">—</span><span class="of">/100</span></div>
              <div class="score-side"><span class="band-label">Nie znamy składu</span></div>
            </div>
            <p>W bazie jest ten produkt, ale bez listy składników, więc nie ma wyniku. Nie zgadujemy go z nazwy.</p>
            <div class="cta-row">
              <a class="btn primary" href="${`/zdjecie?ean=${p.ean}`}">${icon.camera} Zrób zdjęcie składu</a>
              <a class="btn ghost" href="${`https://world.openfoodfacts.org/product/${p.ean}`}" rel="noopener">Uzupełnij w Open Food Facts</a>
            </div>
            <p class="small muted">Zdjęcie odczytamy i pokażemy Ci tekst do sprawdzenia, zanim cokolwiek ocenimy.</p>
          </div>
        `,
      )
    }
${nutritionCard(p.nutrients, p.zeroMayBeMissing)}
${provenance(p, l.fellBack, l.why)}`,
  });
}

export function notFoundPage(what: "product" | "invalid" | "page" | "ingredient", ean = ""): Html {
  const body = what === "invalid"
    ? html`<p>„${ean}” nie jest poprawnym kodem EAN. Sprawdź cyfry pod kodem kreskowym.</p>`
    : what === "product"
    ? html`<p>Nie znaleźliśmy produktu o kodzie <span class="mono">${ean}</span> ani w ns-food, ani w Open Food Facts.</p>
<div class="cta-row"><a class="btn primary" href="${`/zdjecie?ean=${ean}`}">${icon.camera} Zrób zdjęcie składu</a>
<a class="btn ghost" href="https://world.openfoodfacts.org/contribute" rel="noopener">Dodaj do Open Food Facts</a></div>`
    : what === "ingredient"
    ? html`<p>Nie mamy takiego składnika w bazie.</p>`
    : html`<p>Nie ma takiej strony.</p>`;
  return page({
    title: "Nie znaleziono",
    main: html`
      <div
        class="card narrow"><h1 class="h1">Nie znaleziono</h1>${body}<p><a href="/">Strona główna</a></p></div>
    `,
  });
}

export function unavailablePage(ean: string): Html {
  return page({
    title: "Chwilowo niedostępne",
    main: html`
      <div class="card narrow">
        <h1 class="h1">Bazy produktów chwilowo nie odpowiadają</h1>
        <p>Nie udało się pobrać produktu <span class="mono">${ean}</span> ani z ns-food, ani z Open Food Facts. To nie znaczy, że go nie ma. Spróbuj za chwilę.</p>
        <div
          class="cta-row"><a class="btn primary" href="${`/p/${ean}`}">Spróbuj ponownie</a><a class="btn ghost" href="${`/zdjecie?ean=${ean}`}">Oceń ze zdjęcia</a></div>
      </div>
    `,
  });
}

export function tooManyPage(): Html {
  return page({
    title: "Za dużo zapytań",
    main: html`
      <div class="card narrow">
        <h1 class="h1">Za dużo zapytań</h1>
        <p>Zwolnij na chwilę i spróbuj ponownie za kilkanaście sekund.</p>
      </div>
    `,
  });
}

export function ingredientPage(id: string): Html | null {
  const ing = kb().get(id);
  if (!ing) return null;
  const index = kb();
  const name = ing.names.pl?.[0] ?? ing.names.en[0];
  const other = [...(ing.names.pl?.slice(1) ?? []), ...ing.names.en].filter((n) =>
    n.toLowerCase() !== name.toLowerCase()
  ).slice(0, 8);
  const fns = (ing.functions ?? []).map((f) => {
    const n = index.classes.get(f)?.names;
    return n?.pl?.[0] ?? n?.en[0] ?? f;
  });
  const assertions = ing.assertions ?? [];
  const eu = (ing.regulatory ?? []).filter((r) => r.jurisdiction === "EU");
  const statusPl: Record<string, string> = {
    authorised: "dopuszczony",
    restricted: "dopuszczony z ograniczeniami",
    banned: "zakazany",
    not_authorised: "niedopuszczony",
  };
  const certPl: Record<string, string> = { yes: "tak", no: "nie", maybe: "możliwe", unknown: "nie wiadomo" };
  return page({
    title: `${name}${ing.e_number ? ` (${ing.e_number})` : ""}`,
    description: pl(ing.summary) || `${name}: co wiemy o tym składniku i skąd.`,
    main: html`
      <nav class="crumbs small"
        aria-label="Ścieżka"><a href="/">Start</a><span aria-hidden="true">/</span><span>Składnik</span></nav>
      <section class="card">
        <span class="eyebrow mono">${[ing.e_number, ing.type, ...fns].filter(Boolean).join(" · ")}</span>
        <h1 class="display">${name}</h1>
        ${other.length ? html`<p class="muted small">Inne nazwy: ${other.join(", ")}</p>` : ""}
        ${pl(ing.summary) ? html`<p class="lead">${pl(ing.summary)}</p>` : ""}
        ${ing.review_status === "imported"
          ? html`
            <p
              class="note">Ten składnik znamy na razie tylko z nazwy (import z Wikidanych). Nie ma jeszcze oceny w bazie, więc nie zmienia wyniku.</p>
          `
          : ""}
      </section>
      ${assertions.length
        ? html`<section class="card"><h2 class="h2">Co wiemy</h2>${
          assertions.map((as) => {
            const imp = index.implications.get(as.code);
            return html`<div class="fact">
  <div class="fact-head">${grade(as.grade, as.kind)}<b>${
              pl(imp?.label) || as.code
            }</b><span class="muted small">${certPl[as.certainty] ?? as.certainty}</span></div>
  <p class="small">${pl(as.note)}</p>
  <p class="small muted">${
              as.sources.map((sr, i) => {
                const s = index.sources.get(sr.id);
                return html`${i ? " · " : ""}${
                  s?.url ? html`<a href="${s.url}" rel="noopener">${s.title}</a>` : sr.id
                }${sr.locator ? `, ${sr.locator}` : ""}`;
              })
            }</p>
</div>`;
          })
        }</section>`
        : ""}
      ${eu.length
        ? html`
          <section class="card">
            <h2 class="h2">Status w UE</h2>
            <div class="rows">${eu.map((r) =>
              html`<div class="row"><span class="b">${
                statusPl[r.status] ?? r.status
              }</span><span class="muted">${pl(r.conditions)}</span></div>`
            )}</div>
          </section>
        `
        : ""}
      <section class="card">
        <h2 class="h3">Skala dowodów</h2>
        <div class="rows">${Object.entries(GRADE_PL).map(([g, d]) =>
          html`<div class="row">${grade(g)}<span class="muted">${d}</span></div>`
        )}</div>
        <p class="small muted">Opisy składników: <a href="${ENGINE_REPO}">ns-ingredients</a>, CC BY-SA 4.0.</p>
      </section>
    `,
  });
}

export function photoPage(opts: { requestId: string; ean?: string; error?: PhotoError; cap: number }): Html {
  return page({
    title: "Oceń skład ze zdjęcia",
    main: html`<section class="card narrow">
  <h1 class="h1">Oceń skład ze zdjęcia</h1>
  <p>Zrób zdjęcie tyłu opakowania z listą składników, a jeśli chcesz, także przodu z nazwą. Najwyżej ${MAX_PHOTOS} zdjęcia. Odczytamy tekst i pokażemy go do sprawdzenia, zanim cokolwiek ocenimy.</p>
  ${opts.error ? html`<p class="alert" role="alert">${PHOTO_ERROR_PL[opts.error]}</p>` : ""}
  <form id="photo-form" class="photo-form" action="/zdjecie" method="post" enctype="multipart/form-data">
    <input type="hidden" name="request_id" value="${opts.requestId}">
    ${opts.ean ? html`<input type="hidden" name="ean" value="${opts.ean}">` : ""}
    <label class="drop" for="photos">${icon.camera}<span><b>Dodaj zdjęcia</b><br><span class="small muted">JPEG, PNG albo WebP, do 3,5 MB każde</span></span></label>
    <input id="photos" class="file" name="photo" type="file" accept="image/jpeg,image/png,image/webp" multiple required>
    <ul id="previews" class="previews" aria-live="polite"></ul>
    <button class="btn primary" type="submit">Odczytaj skład</button>
    <p id="photo-status" class="small muted" role="status"></p>
  </form>
  <p class="small muted">Zdjęcia wysyłamy do odczytu do modelu Claude firmy Anthropic. Nie zapisujemy ich ani odczytanego tekstu. Anthropic może przechowywać przesłane dane do 30 dni zgodnie ze swoją polityką. Nie fotografuj niczego poza opakowaniem. Dzienny limit odczytów: ${opts.cap}.</p>
</section>
<section class="card narrow">
  <h2 class="h2">Albo wpisz skład</h2>
  ${rateForm({ name: "", ingredients: "", mayContain: "", from: "text", ean: opts.ean ?? "" })}
</section>
<script src="/photo.js" defer></script>`,
  });
}

interface RateFields {
  name: string;
  ingredients: string;
  mayContain: string;
  from: "photo" | "text";
  ean: string;
}

function rateForm(f: RateFields): Html {
  return html`<form class="rate-form" action="/ocen" method="post">
  <input type="hidden" name="from" value="${f.from}">
  ${f.ean ? html`<input type="hidden" name="ean" value="${f.ean}">` : ""}
  <label for="rf-name">Nazwa produktu (opcjonalnie)</label>
  <input id="rf-name" name="name" maxlength="120" value="${f.name}">
  <label for="rf-ing">Składniki</label>
  <textarea id="rf-ing" name="ingredients" rows="8" maxlength="5000" required placeholder="np. mąka pszenna, cukier, jaja 24%, sól">${f.ingredients}</textarea>
  <label for="rf-may">Może zawierać (opcjonalnie)</label>
  <input id="rf-may" name="may_contain" maxlength="500" value="${f.mayContain}">
  <button class="btn primary" type="submit">Oceń ten skład</button>
</form>`;
}

export function confirmPage(
  label: {
    product_name: string;
    brand: string;
    ingredients_text: string;
    may_contain: string;
    legibility: string;
    notes: string;
  },
  ean: string | null,
  known: string,
): Html {
  const name = [label.brand, label.product_name].filter(Boolean).join(" ");
  const may = label.may_contain.replace(/^może zawierać[:\s]*/i, "");
  return page({
    title: "Sprawdź odczytany skład",
    main: html`<section class="card narrow">
  <h1 class="h1">Sprawdź, czy dobrze odczytaliśmy</h1>
  <p>Porównaj tekst z opakowaniem i popraw błędy. Ocenimy dokładnie to, co jest w polu „Składniki”.</p>
  ${
      label.legibility === "partial"
        ? html`<p class="alert" role="alert">Część listy była nieczytelna. Uzupełnij brakujące fragmenty przed oceną.</p>`
        : ""
    }
  ${label.notes ? html`<p class="small muted">Uwagi z odczytu: ${label.notes}</p>` : ""}
  ${
      ean
        ? html`
          <p
            class="small">Na zdjęciu jest kod EAN <span class="mono">${ean}</span>. <a href="${`/p/${ean}`}">Sprawdź, czy mamy go w bazie</a>.</p>
        `
        : ""
    }
  ${
      rateForm({
        name,
        ingredients: label.ingredients_text.replace(/_([^_]+)_/g, "$1"),
        mayContain: may,
        from: "photo",
        ean: known,
      })
    }
  <p class="small muted">Wyróżnienia alergenów z etykiety rozpoznajemy po nazwach, więc nie trzeba ich zaznaczać.</p>
</section>`,
  });
}

export function ratedPage(
  f: { name: string; text: string; from: "photo" | "text" },
  a: AnalysisResult,
  s: Score,
): Html {
  const title = f.name || "Twój skład";
  return page({
    title: `${title}: ocena składu`,
    main: html`
      <section class="hero solo">
        <div class="hero-main">
          <div class="titles">
            <span class="eyebrow mono">${f.from === "photo"
              ? "Odczyt ze zdjęcia, sprawdzony przez Ciebie"
              : "Skład wpisany ręcznie"}</span>
            <h1 class="display">${title}</h1>
          </div>
          ${scoreCard(s)}
          <div class="duo">${allergenCard(a)}${dietCard(a)}</div>
        </div>
      </section>
      ${analysisSections(a, s, f.text)}
      <section class="prov">
        <h2 class="h2">Skąd ta ocena</h2>
        <p
          class="small">Oceniliśmy tekst, który zatwierdziłeś, według reguł v${RULES
            .version}. Nie zapisaliśmy go. Jeśli to produkt ze sklepu, możesz dodać go do Open Food Facts, by był dostępny dla wszystkich.</p>
        <div
          class="prov-links"><a class="btn light" href="/zdjecie">Oceń kolejny</a><a class="btn outline" href="/jak-liczymy">Jak liczymy wynik</a></div>
      </section>
    `,
  });
}

export function methodPage(): Html {
  return page({
    title: "Jak liczymy wynik",
    main: html`
      <article class="card prose">
        <span class="eyebrow mono">Reguły v${RULES.version} · ${RULES.status} · CC BY-SA 4.0</span>
        <h1 class="display">Jak liczymy wynik</h1>
        <p
          class="lead">Zaczynamy od 100 i odejmujemy za grupy składników. Ta sama lista składników zawsze daje ten sam wynik: liczy program, nie model językowy.</p>
        <h2 class="h2">Progi</h2>
        <div class="rows">${RULES.bands.map((b) =>
          html`<div class="row"><span class="b">${b.label}</span><span class="muted">od ${b.min}</span></div>`
        )}</div>
        <h2 class="h2">Za co odejmujemy</h2>
        <p>Grupa liczy się raz, nawet gdy pasuje do kilku składników: trzy cukry to jedna kara, nie trzy.</p>
        <div class="rows">${RULES.groups.map((g) => {
          const w = "by_position" in g && g.by_position
            ? g.by_position.map((b) => `${b.weight} (${b.upto >= 999 ? "dalej" : `do ${b.upto}. miejsca`})`)
              .join(", ")
            : String("weight" in g ? g.weight : "");
          return html`
            <div
              class="row col"><span><b>${g
                .label}</b> <span class="mono">−${w}</span></span><span class="muted small">${g
                .why}</span></div>
          `;
        })}</div>
        <p class="small muted">Wagi są robocze. To nasza ocena redakcyjna, nie wartości z badań.</p>
        <h2 class="h2">Co musi być pewne</h2>
        <p>Kara liczy się tylko wtedy, gdy składnik rozpoznaliśmy pewnie (dokładna nazwa, wariant albo numer E) i gdy dotyczy go wprost, a nie „może”. Rozpoznanie przybliżone nigdy nie obniża wyniku. Kolejność składnika to jego miejsce na liście; składnik wewnątrz złożonego („nadzienie (cukier, …)”) ma miejsce tego złożonego.</p>
        <h2 class="h2" id="bez-wyniku">Kiedy nie ma wyniku</h2>
        <ul class="plain">
          <li>Nie ma listy składników.</li>
          <li>Rozpoznaliśmy pewnie mniej niż ${Math.round(RULES.coverage_min * 100)}% składników.</li>
          <li>Jest dodatek, którego nie rozpoznajemy: numer E, nazwa klasy („barwnik”, „emulgator”) albo pozycja pod nagłówkiem dodatków. Mógłby zmienić wynik, więc go nie zgadujemy.</li>
        </ul>
        <h2 class="h2">Czego nie liczymy</h2>
        <div class="rows">${RULES.not_counted.map((x) =>
          html`<div class="row col"><b>${x.what}</b><span class="muted small">${x.why}</span></div>`
        )}</div>
        <p>Dodatki, które znamy tylko z nazwy (bez oceny w bazie), pokazujemy osobno i nie obniżają wyniku.</p>
        <h2 class="h2">Skala dowodów</h2>
        <div class="rows">${Object.entries(GRADE_PL).map(([g, d]) =>
          html`<div class="row">${grade(g)}<span class="muted">${d}</span></div>`
        )}</div>
        <h2 class="h2">Sprawdź sam</h2>
        <p>Reguły są w pliku <a href="${`${REPO}/blob/${
          COMMIT === "unknown" ? "main" : COMMIT
        }/rules/v0.1.json`}">rules/v0.1.json</a>, a kod, który je stosuje, w <a href="${REPO}">repozytorium</a>. Analizę składu robi <a href="${ENGINE_REPO}">ns-ingredients</a>.</p>
      </article>
    `,
  });
}

export function dataPage(): Html {
  const ref = COMMIT === "unknown" ? "main" : COMMIT;
  return page({
    title: "O danych i licencjach",
    main: html`<article class="card prose">
  <h1 class="display">O danych</h1>
  <h2 class="h2">Skąd produkty</h2>
  <p>Produkty pobieramy z ns-food, który korzysta z Open Food Facts. Gdy ns-food nie odpowiada, ogranicza zapytania albo nie ma kodu, pytamy Open Food Facts bezpośrednio. Przy każdym produkcie piszemy, skąd jest i kiedy go pobraliśmy.</p>
  <p>Dane Open Food Facts są dostępne na licencji <a href="https://opendatacommons.org/licenses/odbl/1-0/">Open Database License (ODbL)</a>, a zdjęcia na CC BY-SA 3.0. Błędy w produktach poprawiaj w <a href="https://world.openfoodfacts.org">Open Food Facts</a>: poprawka trafi do wszystkich.</p>
  <h2 class="h2">Jak powstaje wynik</h2>
  <p>Wynik nie jest zapisaną bazą: liczymy go przy każdym wyświetleniu z danych Open Food Facts, otwartej bazy składników i otwartych reguł. Metoda jest w całości publiczna: kod tej strony, reguły (CC BY-SA 4.0) i silnik analizy. Ten sam skład zawsze da ten sam wynik.</p>
  <h2 class="h2">Silnik analizy</h2>
  <p>Powered by <a href="${ENGINE_REPO}">ns-ingredients (NextSolutions)</a>, AGPL-3.0. Opisy składników: CC BY-SA 4.0; część nazw pochodzi z Wikidanych (CC0).</p>
  <h2 class="h2">Zdjęcia</h2>
  <p>Zdjęcia etykiet wysyłamy do odczytu do modelu Claude firmy Anthropic. Model tylko przepisuje tekst; opis i wynik liczy program. Nie zapisujemy zdjęć ani odczytanego tekstu. Anthropic może przechowywać przesłane dane do 30 dni zgodnie ze swoją polityką. Liczymy tylko, ile zdjęć odczytano danego dnia.</p>
  <h2 class="h2">Kod źródłowy</h2>
  <p>Ta strona jest otwarta (AGPL-3.0): <a href="${`${REPO}/tree/${ref}`}">${
      REPO.replace("https://", "")
    }</a>, wersja <span class="mono">${
      ref.slice(0, 7)
    }</span>. Dane JSON produktu: <span class="mono">/api/product/{EAN}</span>; ocena dowolnego składu: <span class="mono">POST /api/analyze</span>.</p>
  <h2 class="h2">Czym to nie jest</h2>
  <p>To ocena składu z etykiety. Nie jest poradą medyczną ani dietetyczną i nie jest recenzją produktu.</p>
</article>`,
  });
}

export function errorPage(): Html {
  return page({
    title: "Błąd",
    main: html`
      <div class="card narrow">
        <h1 class="h1">Coś poszło nie tak</h1>
        <p>Spróbuj ponownie za chwilę.</p>
      </div>
    `,
  });
}
