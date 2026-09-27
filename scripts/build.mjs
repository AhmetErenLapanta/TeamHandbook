import { build } from "esbuild";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const entryDirs = ["../src/hooks/", "../src/cli/"].map(
  (dir) => new URL(dir, import.meta.url).pathname,
);
const entryPoints = entryDirs.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ in: join(dir, f), out: f.replace(/\.ts$/, "") })),
);
const outdir = new URL("../dist/", import.meta.url).pathname;

await build({
  entryPoints,
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  minify: false,
});

// esbuild never clears outdir, so deleting an entrypoint leaves its bundle behind. dist/ is
// committed, and git reports nothing for a tracked file that did not change, so that orphan is
// invisible to the CI freshness check: measured, the deletion case was the one of four that
// stayed silent. Pruning turns it into a deletion the check does see. It runs after the build,
// not before, so a failed build leaves the committed bundles intact rather than half-erased.
const expected = new Set(entryPoints.map((e) => `${e.out}.js`));
const orphans = readdirSync(outdir).filter(
  (f) => f.endsWith(".js") && !expected.has(f),
);
for (const f of orphans) rmSync(join(outdir, f));

console.log(
  `built ${entryPoints.length} hook bundle(s) to dist/` +
    (orphans.length ? `, pruned ${orphans.length} orphan(s): ${orphans.join(", ")}` : ""),
);
