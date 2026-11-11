// `npm run dev`: the server rebuilt and restarted on every change, and the web served by Vite
// with its hot reload, both from one command; the browser opens on Vite's address, which sends
// /api to the server.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { context } from "esbuild";

// A flag given here would be dropped without a word, so none is taken: settings go in ORCHESTRATOR_*.
if (process.argv.length > 2) {
  console.error("npm run dev takes no arguments; set the port and the rest with ORCHESTRATOR_* settings, for instance ORCHESTRATOR_PORT=8090 npm run dev");
  process.exit(2);
}

const ctx = await context({
  entryPoints: { server: "server/main.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "warning",
});
await ctx.rebuild();
// The demo's stand-in agent runs as its own process, so it is copied as the plain script it is, as the build does.
mkdirSync("dist", { recursive: true });
copyFileSync("demo/fake-agent.mjs", "dist/fake-agent.mjs");
await ctx.watch();

const env = { ...process.env, ORCHESTRATOR_PORT: process.env.ORCHESTRATOR_PORT || "8080", ORCHESTRATOR_NO_BROWSER: "1" };
const children = [
  spawn(process.execPath, ["--watch-path=dist/server.js", "dist/server.js"], { stdio: "inherit", env }),
  spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["vite", "--open"], { stdio: "inherit" }),
];
const stop = () => {
  for (const child of children) child.kill("SIGTERM");
  void ctx.dispose().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", (code) => code && stop());
