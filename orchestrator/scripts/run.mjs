// `npm start` and `npm run dev` from the repository root on a fresh clone: the orchestrator's
// dependencies are installed when the lockfile has moved past what was installed, then the
// orchestrator's own script of the same name runs (it builds when the build is stale). Node
// built-ins only, since this runs before anything is installed.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeTooOld } from "./node-guard.mjs";

const orchestratorDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const [command, ...rest] = process.argv.slice(2);
const tooOld = nodeTooOld(JSON.parse(readFileSync(join(orchestratorDir, "package.json"), "utf8")).engines.node);
if (tooOld) {
  console.error(tooOld);
  process.exit(1);
}
if (command !== "start" && command !== "dev") {
  console.error("usage: node orchestrator/scripts/run.mjs start | dev [arguments for the orchestrator]");
  process.exit(2);
}

const installed = join(orchestratorDir, "node_modules", ".package-lock.json");
if (!existsSync(installed) || statSync(join(orchestratorDir, "package-lock.json")).mtimeMs > statSync(installed).mtimeMs) {
  console.log("Installing the orchestrator's dependencies (npm ci); this happens once, and again when they change.");
  const done = spawnSync(npm, ["ci", "--no-audit", "--no-fund"], { cwd: orchestratorDir, stdio: "inherit" });
  if (done.status !== 0) process.exit(done.status ?? 1);
}

// In the foreground: a stop asked of this process is passed on, and its exit is this one's.
const child = spawn(npm, ["run", "--silent", command, ...(rest.length ? ["--", ...rest] : [])], { cwd: orchestratorDir, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
