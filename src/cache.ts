/**
 * Only the raw upstream answer is cached, never the analysis: a new knowledge base or rule version applies on the
 * next request. Misses are cached only when both sources said "no such product"; an answer degraded by a failing
 * upstream is never cached as a miss.
 */
import type { Lookup } from "./data/product.ts";

const VERSION = "p1";

export interface ProductCache {
  get(ean: string): Promise<Lookup | null>;
  put(ean: string, lookup: Lookup, ttlSeconds: number): Promise<void>;
}

export function ttlFor(l: Lookup): number | null {
  if (l.status === "found") return l.fellBack && l.why !== "not in ns-food" ? 1800 : 21600;
  if (l.status === "not_found" && l.why === "not in ns-food") return 3600;
  return null;
}

export function edgeCache(cache: Cache): ProductCache {
  const key = (ean: string) => new Request(`https://cache.airon-sklad.invalid/${VERSION}/product/${ean}`);
  return {
    async get(ean) {
      const hit = await cache.match(key(ean));
      return hit ? await hit.json() as Lookup : null;
    },
    async put(ean, lookup, ttl) {
      await cache.put(
        key(ean),
        new Response(JSON.stringify(lookup), {
          headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
        }),
      );
    },
  };
}

/** For tests and local runs. */
export function memoryCache(): ProductCache & { size(): number } {
  const m = new Map<string, Lookup>();
  return {
    get: (ean) => Promise.resolve(m.get(ean) ?? null),
    put: (ean, l) => {
      m.set(ean, l);
      return Promise.resolve();
    },
    size: () => m.size,
  };
}
