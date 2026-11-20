import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { cleanMachine, freePort } from "../clean-machine.js";
import { browserStandIn, claudeStandIn, mirrorOf, personsRepository, signInAt, started, until } from "../solo.js";
import { labDir } from "../state.js";

/**
 * A person on 0.3.0 who updates: install.sh puts 0.3.0 on a clean machine from a mirror holding both releases,
 * the person opens a project, `update --check` says 0.3.1 is there, `update --prepare` places it and leaves 0.3.0
 * current, `update --apply --yes` makes it current, and the orchestrator that starts then holds the project and
 * the same schema number it left. LAB_UPDATE_RELEASES names a directory holding both releases' files, built from the
 * two release commits; without it the scenario skips. The machine reaches only the mirror on this machine.
 */
const RELEASES = process.env.LAB_UPDATE_RELEASES ?? "";
const FROM = process.env.LAB_UPDATE_FROM ?? "0.3.0";
const TO = process.env.LAB_UPDATE_TO ?? "0.3.1";
const stamp = (what: string) => join(labDir(), "update-path", `${what}-${Date.now().toString(36)}`);

test.skip(!RELEASES, "LAB_UPDATE_RELEASES names no directory of two releases");

test(`given ${FROM} installed with a project opened, when the person checks, prepares and applies ${TO}, then each step says what it did, ${FROM} stays current until the apply, and ${TO} starts on the same schema with the project`, async ({ page }) => {
  test.setTimeout(900_000);
  // given
  const root = stamp("zero-three");
  const machine = cleanMachine(root, process.env.PATH ?? "");
  const mirror = await mirrorOf(RELEASES);
  const opened = browserStandIn(root);
  const home = join(machine.home, ".handbook-orchestrator");
  const env = { ...machine.env, BROWSER: opened.command, ORCHESTRATOR_CLAUDE_BIN: claudeStandIn(root), HANDBOOK_ORCHESTRATOR_RELEASE_BASE_URL: mirror.url };
  const binary = join(machine.home, ".local", "bin", "handbook-orchestrator");
  // Awaited, never blocking: the mirror answers from this process.
  const finish = (command: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(command, args, { env: { ...env, ...extra }, cwd: machine.home });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
      child.on("exit", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
  const update = (...args: string[]) => finish(binary, ["update", ...args]);
  const schema = () => spawnSync("sqlite3", [join(machine.home, "Library", "Application Support", "TeamHandbook Orchestrator", "orchestrator.db"), "SELECT MAX(version) FROM schema_version"], { encoding: "utf8" }).stdout.trim();
  const current = () => readlinkSync(join(home, "current")).split("/").pop()!;
  const run = async (version: string) => {
    const port = await freePort();
    const child = started(binary, ["--port", String(port)], env, machine.home);
    await until(() => fetch(`http://127.0.0.1:${port}/api/health/ready`).then((r) => r.json() as Promise<{ ready?: boolean }>, (): { ready?: boolean } => ({})), (r) => r.ready === true, 600);
    return { child, base: `http://127.0.0.1:${port}`, version };
  };
  const stop = async (r: { child: { child: { pid?: number }; exited: Promise<number | null> } }) => {
    process.kill(-r.child.child.pid!, "SIGINT");
    await Promise.race([r.child.exited, new Promise((resolve) => setTimeout(resolve, 20_000))]);
  };
  try {
    const install = await finish("/bin/sh", ["-c", `curl -fsSL '${mirror.url}install.sh' | sh`], { HANDBOOK_ORCHESTRATOR_VERSION: FROM });
    expect(install.status, install.stdout + install.stderr).toBe(0);
    expect(current()).toBe(FROM);
    const repo = personsRepository(machine);
    const first = await run(FROM);
    const link = await until(() => opened.opened(), (o) => o.length > 0, 120);
    await signInAt(page, /url=([^"]+)"/.exec(readFileSync(link[0]!, "utf8"))![1]!.replace(/&amp;/g, "&"));
    const { csrf } = (await (await page.request.get(`${first.base}/api/me`)).json()) as { csrf: string };
    const open = await page.request.post(`${first.base}/api/projects`, { headers: { "x-csrf-token": csrf }, data: { path: repo } });
    expect(open.status(), "opening the project").toBe(200);
    await stop({ child: first.child });
    const before = schema();
    expect(before, "the schema number the old version left").toMatch(/^\d+$/);

    // when the person checks, prepares and applies
    const check = await update("--check");
    const prepare = await update("--prepare");
    const keptCurrent = current();
    const apply = await update("--apply", "--yes");

    // then
    expect(check.status, check.stdout + check.stderr).toBe(0);
    expect(check.stdout + check.stderr).toContain(TO);
    expect(prepare.status, prepare.stdout + prepare.stderr).toBe(0);
    expect(existsSync(join(home, "versions", TO))).toBe(true);
    expect(keptCurrent, "current while only prepared").toBe(FROM);
    expect(apply.status, apply.stdout + apply.stderr).toBe(0);
    expect(current()).toBe(TO);
    const second = await run(TO);
    try {
      const link2 = await until(() => opened.opened(), (o) => o.length > 1, 120);
      await signInAt(page, /url=([^"]+)"/.exec(readFileSync(link2[link2.length - 1]!, "utf8"))![1]!.replace(/&amp;/g, "&"));
      const { projects } = (await (await page.request.get(`${second.base}/api/projects`)).json()) as { projects: { path?: string; name?: string }[] };
      expect(JSON.stringify(projects)).toContain("delivery-service");
    } finally {
      await stop({ child: second.child });
    }
    expect(schema(), "the schema number after the update").toBe(before);
    expect(machine.trapped().filter((call) => !["--version", "auth list"].includes(call.args))).toEqual([]);
  } finally {
    await mirror.close();
  }
});
