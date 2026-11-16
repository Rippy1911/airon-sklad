/** The slices of the Workers runtime this site uses, typed locally so `deno check` and the tests need no CF types. */

export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface D1Like {
  prepare(sql: string): D1Stmt;
}

export interface RateLimit {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

export interface Assets {
  fetch(req: Request): Promise<Response>;
}

export interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

export interface Env {
  ASSETS?: Assets;
  DB?: D1Like;
  PHOTO_LIMIT?: RateLimit;
  PAGE_LIMIT?: RateLimit;
  IMG_LIMIT?: RateLimit;
  NS_FOOD_URL: string;
  NS_FOOD_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  PHOTO_DAILY_CAP?: string;
  PHOTO_MODEL?: string;
}
