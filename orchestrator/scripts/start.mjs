// `npm start` from a fresh clone or after a pull: builds when the bundle is missing or older than
// a source it is made from, then runs the orchestrator's command line with the arguments given, so
// `npm start -- --port 8090 --no-open` reads them as the installed command does and a word it does
// not know stops the start instead of being dropped.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SOURCES = ["server", "shared", "web", "demo", "../src/lib", "package.json", "build.mjs", "vite.config.ts"];
const BUILT = ["dist/server.js", "dist/cli.js", "dist/web/index.html"];

function newest(path) {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let latest = stat.mtimeMs;
  for (const name of readdirSync(path)) if (name !== "node_modules" && name !== "dist") latest = Math.max(latest, newest(join(path, name)));
  return latest;
}

const builtAt = Math.min(...BUILT.map((file) => (existsSync(file) ? statSync(file).mtimeMs : 0)));
if (!builtAt || Math.max(...SOURCES.map(newest)) > builtAt) {
  console.log("Building the orchestrator first; this happens once after each update.");
  const build = spawnSync("npm", ["run", "build"], { stdio: "inherit", shell: process.platform === "win32" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const server = spawn(process.execPath, ["dist/cli.js", ...process.argv.slice(2)], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
