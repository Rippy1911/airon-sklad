// Local dev with real keys, none written to disk: the keys come from this process's environment.
//   NS_FOOD_SKLAD_KEY=… ANTHROPIC_API_KEY=… node scripts/dev.mjs   (or let a secrets manager inject them)
// Without the vault the site still runs: products come from Open Food Facts and photo reading is off.
import { spawn } from "node:child_process";

const env = {
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
};
if (process.env.NS_FOOD_SKLAD_KEY) env.NS_FOOD_KEY = process.env.NS_FOOD_SKLAD_KEY;
if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];

const run = (args) =>
  new Promise((ok, fail) => {
    const p = spawn("npx", ["wrangler", ...args], {
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });
    p.on("exit", (c) => (c === 0 ? ok() : fail(new Error(`wrangler ${args[0]} exited ${c}`))));
  });

await run(["d1", "migrations", "apply", "airon-sklad", "--local"]);
const args = process.argv.slice(2);
await run(["dev", ...(args.includes("--port") ? [] : ["--port", process.env.PORT ?? "8788"]), ...args]);
