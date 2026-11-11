import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { labEnv, labGit } from "./run.js";
import type { LabState } from "./state.js";

/**
 * The orchestrator as `ref` of this repository built it, in the lab directory, once per ref: an
 * older release to start on a database the current orchestrator then opens.
 */
export function orchestratorBuildAt(lab: Pick<LabState, "dir" | "path" | "orchestratorDir">, ref: string): string {
  const sha = labGit(lab.path, ["rev-parse", "--verify", `${ref}^{commit}`], lab.orchestratorDir);
  const root = join(lab.dir, "builds", sha.slice(0, 12));
  const build = join(root, "orchestrator");
  if (existsSync(join(build, "dist", "server.js"))) return build;
  mkdirSync(root, { recursive: true });
  const archive = spawnSync("git", ["-C", dirname(lab.orchestratorDir), "archive", "--format=tar", sha, "orchestrator", "src", "package.json"], { env: labEnv(lab.path, { HOME: root }), maxBuffer: 512 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive ${ref} failed`);
  const unpack = spawnSync("tar", ["-x", "-C", root], { input: archive.stdout, env: labEnv(lab.path, { HOME: root }) });
  if (unpack.status !== 0) throw new Error(`unpacking ${ref} failed`);
  symlinkSync(join(lab.orchestratorDir, "node_modules"), join(build, "node_modules"));
  // The build's own tools, from the orchestrator's node_modules: no install and no network.
  const built = spawnSync("node", ["build.mjs"], { cwd: build, env: labEnv(lab.path, { HOME: root }), encoding: "utf8" });
  const web = spawnSync("node", [join(lab.orchestratorDir, "node_modules", "vite", "bin", "vite.js"), "build"], { cwd: build, env: labEnv(lab.path, { HOME: root }), encoding: "utf8" });
  if (built.status !== 0 || web.status !== 0) throw new Error(`building the orchestrator at ${ref} failed: ${built.stderr}${web.stderr}`);
  return build;
}
