import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const hooksDir = new URL("../src/hooks/", import.meta.url).pathname;
const entryPoints = readdirSync(hooksDir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => join(hooksDir, f));

await build({
  entryPoints,
  outdir: new URL("../dist/", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  sourcemap: false,
  minify: false,
});

console.log(`built ${entryPoints.length} hook bundle(s) to dist/`);
