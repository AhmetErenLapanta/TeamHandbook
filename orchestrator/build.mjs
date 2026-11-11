import { copyFileSync } from "node:fs";
import { build } from "esbuild";

// The server and the demo seed are bundled the way the plugin's own bundles are: one file
// each, with the plugin's src/lib code they reuse inlined, so the image needs no
// TypeScript and the orchestrator never resolves the plugin's sources at run time. dist/cli.js
// is the command line `npm start` reads, the same one the package's bin and the executable read.
await build({
  entryPoints: { server: "server/main.ts", cli: "server/cli-main.ts", seed: "demo/seed.ts", "docker-proxy": "server/docker-proxy-main.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "warning",
});
// The demo's stand-in agent runs as its own process, so it ships as the plain script it is.
copyFileSync("demo/fake-agent.mjs", "dist/fake-agent.mjs");
console.log("built dist/server.js, dist/cli.js, dist/seed.js, dist/docker-proxy.js and dist/fake-agent.mjs");
