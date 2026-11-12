// `npm run build:package`: the npm package `npx teamhandbook-orchestrator` runs, packed as a
// tarball in package-out/ and published nowhere. It holds the server bundle, the web app, the
// stand-in agent and a bin, with no dependencies, so the tarball runs without the registry.
// The Docker pieces (compose, docker-proxy, the demo seed) stay out: they are a team's install.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlaces, packageLeaks } from "./package-hygiene.mjs";
import { fontsWithoutLicence, missingStyleAssets } from "./web-assets.mjs";
import { build } from "esbuild";

const orchestratorDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(orchestratorDir, "package-out");
const stage = join(out, "teamhandbook-orchestrator");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const manifest = JSON.parse(readFileSync(join(orchestratorDir, "package.json"), "utf8"));

function run(command, args, cwd) {
  const done = spawnSync(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  if (done.status !== 0) process.exit(done.status ?? 1);
  return done.stdout;
}

if (!process.argv.includes("--no-build")) run(npm, ["run", "--silent", "build"], orchestratorDir);

// Only the package's own stage and tarballs: package-out/release/ is build:release's, made beside it.
rmSync(stage, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of readdirSync(out)) if (/^teamhandbook-orchestrator-.*\.tgz$/.test(name)) rmSync(join(out, name));
mkdirSync(join(stage, "bin"), { recursive: true });
mkdirSync(join(stage, "dist"), { recursive: true });
await build({
  entryPoints: [join(orchestratorDir, "server", "cli-main.ts")],
  outfile: join(stage, "bin", "main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
});
// The bin asks the Node version before it loads the bundle: on an older Node the bundle's own
// imports fail first, with a stack trace instead of a sentence.
copyFileSync(join(orchestratorDir, "scripts", "node-guard.mjs"), join(stage, "bin", "node-guard.mjs"));
writeFileSync(
  join(stage, "bin", "handbook-orchestrator.mjs"),
  `#!/usr/bin/env node
import { nodeTooOld } from "./node-guard.mjs";
const tooOld = nodeTooOld(${JSON.stringify(manifest.engines.node)});
if (tooOld) {
  console.error(tooOld);
  process.exit(1);
}
await import("./main.mjs");
`,
);
chmodSync(join(stage, "bin", "handbook-orchestrator.mjs"), 0o755);
copyFileSync(join(orchestratorDir, "dist", "server.js"), join(stage, "dist", "server.js"));
copyFileSync(join(orchestratorDir, "dist", "fake-agent.mjs"), join(stage, "dist", "fake-agent.mjs"));
cpSync(join(orchestratorDir, "dist", "web"), join(stage, "dist", "web"), { recursive: true });
const unlicensed = fontsWithoutLicence(join(orchestratorDir, "dist", "web"));
if (unlicensed.length) {
  console.error(`the package would carry fonts with no OFL or LICENSE text beside them: ${unlicensed.join(", ")}`);
  process.exit(1);
}
const unshipped = missingStyleAssets(join(orchestratorDir, "dist", "web"));
if (unshipped.length) {
  console.error(`the package's stylesheets name files the build does not hold: ${unshipped.join(", ")}`);
  process.exit(1);
}
copyFileSync(join(orchestratorDir, "..", "LICENSE"), join(stage, "LICENSE"));
writeFileSync(
  join(stage, "README.md"),
  `# TeamHandbook Orchestrator

\`npx teamhandbook-orchestrator@latest\` starts the orchestrator on your machine, for you alone:
it listens on 127.0.0.1, keeps its data in your system's place for application data and opens it
in your browser. \`npx teamhandbook-orchestrator --help\` lists its flags.

Source, documentation and the team and cloud installs: https://github.com/AhmetErenLapanta/TeamHandbook
`,
);
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "teamhandbook-orchestrator",
      version: manifest.version,
      description: "Run your coding agents and your team's sprint from one page on your own machine: npx teamhandbook-orchestrator",
      type: "module",
      license: manifest.license,
      engines: manifest.engines,
      // npm's page for the package links back to the source from these.
      repository: { type: "git", url: "git+https://github.com/AhmetErenLapanta/TeamHandbook.git", directory: "orchestrator" },
      homepage: "https://github.com/AhmetErenLapanta/TeamHandbook/tree/master/orchestrator#readme",
      bugs: { url: "https://github.com/AhmetErenLapanta/TeamHandbook/issues" },
      bin: { "teamhandbook-orchestrator": "bin/handbook-orchestrator.mjs", "handbook-orchestrator": "bin/handbook-orchestrator.mjs" },
      files: ["bin", "dist", "LICENSE", "README.md"],
    },
    null,
    2,
  ) + "\n",
);
const leaks = packageLeaks(stage, buildPlaces(join(orchestratorDir, "..")));
if (leaks.length) {
  console.error(`the package would carry what stays on this machine: ${leaks.join(", ")}`);
  process.exit(1);
}
const packed = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", out], stage))[0];
console.log(`${join(out, packed.filename)} (${packed.entryCount} files, ${(packed.size / 1024).toFixed(0)} KB)`);
