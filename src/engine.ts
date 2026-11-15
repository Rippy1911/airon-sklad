/** The ns-ingredients analyser and knowledge base, bundled into the Worker (vendor/ns-ingredients, AGPL-3.0). */
import bundle from "../vendor/ns-ingredients/dist/kb-bundle.json" with { type: "json" };
import { KbIndex } from "../vendor/ns-ingredients/src/core/kb-index.ts";
import { type AnalysisResult, analyze } from "../vendor/ns-ingredients/src/core/analyze.ts";
import type { KbBundle } from "../vendor/ns-ingredients/src/kb/schema.ts";

export type { AnalysisResult };
export type ItemResult = AnalysisResult["items"][number];
export type Flag = AnalysisResult["flags"][number];

let index: KbIndex | null = null;
export function kb(): KbIndex {
  index ??= new KbIndex(bundle as unknown as KbBundle);
  return index;
}

export function analyse(text: string): AnalysisResult {
  return analyze(kb(), text, { lang: "pl" });
}

/** Depth-first list of every item. */
export function flatItems(items: ItemResult[], out: ItemResult[] = []): ItemResult[] {
  for (const it of items) {
    out.push(it);
    flatItems(it.children, out);
  }
  return out;
}
