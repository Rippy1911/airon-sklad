/**
 * The one way to produce HTML: tagged templates that escape every interpolated value. Product names, ingredient lists
 * and photo transcriptions are untrusted crowd or model data; they can only reach the page through `html`.
 */
import { COMMIT } from "./build-info.ts";

export class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

function render(v: unknown): string {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false || v === true) return "";
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Html(out);
}

/** Only for fixed markup written in this repo, never for data. */
export const trusted = (s: string) => new Html(s);

export const REPO = "https://github.com/Rippy1911/airon-sklad";
export const ENGINE_REPO = "https://github.com/NextSolutionsStudio/ns-ingredients";

const logo = trusted(
  `<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true"><rect x="1" y="1" width="28" height="28" rx="7" fill="currentColor"></rect><path d="M8 10h14M8 15h10M8 20h6" stroke="#fff" stroke-width="2.4" stroke-linecap="round"></path></svg>`,
);

export const icon = {
  search: trusted(
    `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>`,
  ),
  camera: trusted(
    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"></path><circle cx="12" cy="13" r="3.5"></circle></svg>`,
  ),
  pack: trusted(
    `<svg width="160" height="126" viewBox="0 0 190 150" aria-hidden="true"><rect x="12" y="34" width="166" height="84" rx="12" fill="#fff" stroke="#B9BEB5" stroke-width="2"></rect><rect x="28" y="52" width="76" height="12" rx="4" fill="#DCDFD8"></rect><rect x="28" y="72" width="52" height="8" rx="4" fill="#E7EAE4"></rect></svg>`,
  ),
};

export interface PageOpts {
  title: string;
  description?: string;
  q?: string;
  main: Html;
}

export function page({ title, description, q, main }: PageOpts): Html {
  return html`
    <!doctype html>
    <html lang="pl">
      <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>${title} · airon skład</title>
    ${description ? html`<meta name="description" content="${description}">` : ""}
    <link rel="stylesheet" href="/fonts/fonts.css">
    <link rel="stylesheet" href="/styles.css">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
      </head>
      <body>
        <div class="beta"
          role="note">Wersja testowa · reguły wyniku v0.1 (robocze) · strona nie jest indeksowana</div>
        <header class="top">
          <div class="wrap top-row">
            <a class="brand" href="/">${logo}<span>airon <b>skład</b></span></a>
            <form class="search" action="/szukaj" method="get" role="search">
          ${icon.search}
          <label class="sr" for="q">Szukaj produktu</label>
          <input id="q" name="q" type="search" value="${q ??
            ""}" placeholder="Nazwa produktu albo kod EAN" autocomplete="off">
        </form>
            <nav class="nav" aria-label="Główne">
              <a href="/zdjecie">Zdjęcie składu</a>
              <a href="/jak-liczymy">Jak liczymy</a>
              <a href="/o-danych">O danych</a>
            </nav>
          </div>
        </header>
        <main class="wrap main">${main}</main>
        <footer class="foot">
          <div class="wrap foot-grid">
            <p>Zawiera dane z <a href="https://world.openfoodfacts.org">Open Food Facts</a> (ODbL); zdjęcia produktów: Open Food Facts, CC BY-SA 3.0. To ocena składu z etykiety, nie porada medyczna i nie recenzja produktu.</p>
            <p>Powered by <a href="${ENGINE_REPO}">ns-ingredients (NextSolutions)</a>. Opisy składników: CC BY-SA 4.0.</p>
            <p>Kod źródłowy (AGPL-3.0): <a href="${REPO}/tree/${COMMIT}">${REPO.replace(
              "https://",
              "",
            )} @ ${COMMIT.slice(0, 7)}</a></p>
          </div>
        </footer>
      </body>
    </html>
  `;
}

export const fmtNum = (n: number) => n.toLocaleString("pl-PL", { maximumFractionDigits: n < 10 ? 2 : 1 });
