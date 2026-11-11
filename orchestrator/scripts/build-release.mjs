// `npm run build:release`: the orchestrator as one executable for this machine's platform, with
// no Node needed to run it, packed for install.sh: package-out/release/ holds
// handbook-orchestrator-<version>-<platform>.tar.gz, SHA256SUMS and manifest.json, and a second
// platform built into the same directory is added to both. Published nowhere from here.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlaces, packageLeaks } from "./package-hygiene.mjs";
import { fontsWithoutLicence, missingStyleAssets } from "./web-assets.mjs";
import { build } from "esbuild";

const orchestratorDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(orchestratorDir, "package-out", "release");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const version = JSON.parse(readFileSync(join(orchestratorDir, "package.json"), "utf8")).version;
const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const name = `handbook-orchestrator-${version}-${platform}`;
const stage = join(out, name);
const binary = join(stage, process.platform === "win32" ? "handbook-orchestrator.exe" : "handbook-orchestrator");

function run(command, args, options = {}) {
  const done = spawnSync(command, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...options });
  if (done.status !== 0) {
    console.error(`${command} ${args.join(" ")} failed`);
    process.exit(done.status ?? 1);
  }
  return done.stdout;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer().once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// The page's fallback answers every unknown path with the page itself, so a file counts only with its own type.
async function served(url, type) {
  const response = await fetch(url).catch(() => null);
  return response?.ok && response.headers.get("content-type")?.startsWith(type) ? response : null;
}

const running = (child) => child.exitCode === null && child.signalCode === null;

/** What the started executable fails to serve, or null once its health, its first page and a font that page's stylesheet names answer. */
async function servesFirstPage(base, child) {
  const deadline = Date.now() + 60_000;
  while (!(await served(`${base}/api/health`, "application/json"))) {
    if (!running(child)) return `exited (${child.exitCode ?? child.signalCode}) before it answered /api/health`;
    if (Date.now() > deadline) return "did not answer /api/health within 60 s";
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const page = await served(`${base}/`, "text/html");
  if (!page) return "does not serve its page at /";
  const sheet = (await page.text()).match(/href="([^"]+\.css)"/)?.[1];
  const styles = sheet ? await served(new URL(sheet, `${base}/`), "text/css") : null;
  if (!styles) return `does not serve the stylesheet its page names (${sheet ?? "none"})`;
  const font = (await styles.text()).match(/url\(\s*["']?([^"')]+\.woff2)/)?.[1];
  if (!font || !(await served(new URL(font, styles.url), "font/woff2"))) return `does not serve a font its stylesheet names (${font ?? "none"})`;
  return null;
}

async function stopped(child) {
  if (!running(child)) return true;
  const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
  child.kill("SIGTERM");
  const stops = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(false), 20_000))]);
  if (!stops) child.kill("SIGKILL");
  return stops;
}

if (!process.argv.includes("--no-build")) run(npm, ["run", "--silent", "build"], { cwd: orchestratorDir });

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const work = join(out, ".work", platform);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

await build({
  entryPoints: [join(orchestratorDir, "server", "sea-main.ts")],
  outfile: join(work, "app.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  define: { ORCHESTRATOR_VERSION: JSON.stringify(version) },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "warning",
});
// vm modules let the executable run the orchestrator's own small scripts as node would (server/script-runner.ts).
// The executable keeps the main script's name as sea.json gives it, so it is given relative to the
// work directory: an absolute one would carry the build machine's path into every download.
writeFileSync(join(work, "sea.json"), JSON.stringify({ main: "app.mjs", mainFormat: "module", output: binary, disableExperimentalSEAWarning: true, execArgv: ["--experimental-vm-modules", "--no-warnings"] }, null, 2));
run(process.execPath, ["--build-sea", "sea.json"], { cwd: work });
// macOS on Apple silicon runs no unsigned executable; an ad-hoc signature until there is a Developer ID.
if (process.platform === "darwin") run("codesign", ["--sign", "-", "--force", binary]);

cpSync(join(orchestratorDir, "dist", "web"), join(stage, "web"), { recursive: true });
const unlicensed = fontsWithoutLicence(join(orchestratorDir, "dist", "web"));
if (unlicensed.length) {
  console.error(`the release would carry fonts with no OFL or LICENSE text beside them: ${unlicensed.join(", ")}`);
  process.exit(1);
}
const unshipped = missingStyleAssets(join(orchestratorDir, "dist", "web"));
if (unshipped.length) {
  console.error(`the release's stylesheets name files the build does not hold: ${unshipped.join(", ")}`);
  process.exit(1);
}
copyFileSync(join(orchestratorDir, "dist", "fake-agent.mjs"), join(stage, "fake-agent.mjs"));
copyFileSync(join(orchestratorDir, "..", "LICENSE"), join(stage, "LICENSE"));
writeFileSync(join(stage, "VERSION"), `${version}\n`);

// The executable answers with nothing from this machine on its PATH.
const said = run(binary, ["--version"], { env: { PATH: "" } }).trim();
if (said !== `teamhandbook-orchestrator ${version}`) {
  console.error(`the built executable says "${said}"`);
  process.exit(1);
}

// A release job's platform runs nowhere before it ships, so the executable starts the orchestrator
// itself here: a fresh data directory, nothing of this machine's on its PATH or in its home, a port
// the system hands out. It serves its page and the fonts it ships, and stops on SIGTERM.
const place = mkdtempSync(join(tmpdir(), "handbook-orchestrator-boot-"));
mkdirSync(join(place, "home"));
const port = await freePort();
const child = spawn(binary, ["--no-open", "--port", String(port), "--data-dir", join(place, "data")], { env: { PATH: "", HOME: join(place, "home") }, stdio: ["ignore", "pipe", "pipe"] });
let told = "";
child.stdout.on("data", (chunk) => (told += chunk));
child.stderr.on("data", (chunk) => (told += chunk));
const refused = await servesFirstPage(`http://127.0.0.1:${port}`, child);
const stops = await stopped(child);
rmSync(place, { recursive: true, force: true });
if (refused || !stops) {
  console.error(`the built executable ${refused ?? "did not stop within 20 s of SIGTERM"}; it said:\n${told}`);
  process.exit(1);
}

const archive = `${name}.tar.gz`;
const leaks = packageLeaks(stage, buildPlaces(join(orchestratorDir, "..")));
if (leaks.length) {
  console.error(`the release would carry what stays on this machine: ${leaks.join(", ")}`);
  process.exit(1);
}
run("tar", ["--no-xattrs", "-czf", join(out, archive), "-C", out, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
const sha256 = createHash("sha256").update(readFileSync(join(out, archive))).digest("hex");

const sumsFile = join(out, "SHA256SUMS");
const sums = existsSync(sumsFile) ? readFileSync(sumsFile, "utf8").split("\n").filter((line) => line && !line.endsWith(`  ${archive}`)) : [];
writeFileSync(sumsFile, [...sums, `${sha256}  ${archive}`].sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join("\n") + "\n");

const manifestFile = join(out, "manifest.json");
const previous = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : null;
const archives = previous?.version === version ? previous.archives : {};
archives[platform] = { file: archive, sha256, size: statSync(join(out, archive)).size, node: process.version };
// schema numbers the manifest's own shape, so install.sh and update read only one they know.
writeFileSync(manifestFile, JSON.stringify({ schema: 1, name: "handbook-orchestrator", version, released: previous?.version === version ? previous.released : new Date().toISOString().slice(0, 10), archives }, null, 2) + "\n");

copyFileSync(join(orchestratorDir, "scripts", "install.sh"), join(out, "install.sh"));
copyFileSync(join(orchestratorDir, "scripts", "install.ps1"), join(out, "install.ps1"));
rmSync(join(out, ".work"), { recursive: true, force: true });
console.log(`${join(out, archive)} (${(statSync(join(out, archive)).size / 1024 / 1024).toFixed(1)} MB), SHA256SUMS and manifest.json in ${out}`);
