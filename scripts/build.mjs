import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const entryDirs = ["../src/hooks/", "../src/cli/"].map(
  (dir) => new URL(dir, import.meta.url).pathname,
);
const entryPoints = entryDirs.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ in: join(dir, f), out: f.replace(/\.ts$/, "") })),
);

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
