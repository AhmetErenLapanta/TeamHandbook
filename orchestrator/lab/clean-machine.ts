import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { labEnv } from "./run.js";

/**
 * The agent CLIs a clean machine's PATH answers with a trap, ahead of everything else: a call is
 * written down and refused, so no real one starts whatever else is installed. A scenario hands its
 * stand-in agent over by ORCHESTRATOR_CLAUDE_BIN and by nothing else.
 */
export const TRAPPED = ["claude", "opencode", "codex", "cursor-agent", "gemini"];

/** Trapped as well on a clean machine: nothing there starts a container, and no real browser opens; a scenario names its browser stand-in in BROWSER. */
const ALSO_TRAPPED = ["docker", "open", "xdg-open", "wslview"];

/** Never on a clean machine's PATH at all: a person without them is what the scenarios start from. */
const ABSENT = ["gh", "glab"];

/**
 * Where npm would fetch from: a loopback address nothing answers on, so a command that reaches for
 * the registry fails at once instead of downloading.
 */
export const NO_REGISTRY = "http://127.0.0.1:9/";

export interface CleanMachine {
  home: string;
  path: string;
  env: NodeJS.ProcessEnv;
  trapLog: string;
  /** Each trapped call: the name called and its arguments. */
  trapped: () => { name: string; args: string }[];
}

function onPath(name: string, path: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

/**
 * A machine with nothing on it but git, node and npm: a home of its own with a git identity, an
 * empty npm cache that never reaches a registry, and a PATH of the trap, those four tools linked by
 * themselves and the system's own directories. Node's own directory is never on it, since a
 * person's globally installed CLIs, Claude Code among them, sit there beside node.
 */
export function cleanMachine(root: string, hostPath: string): CleanMachine {
  const home = join(root, "home");
  const trap = join(root, "trap");
  const tools = join(root, "tools");
  const trapLog = join(root, "trap.log");
  for (const dir of [home, join(home, "tmp"), trap, tools, join(root, "npm-cache")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Solo Person\n\temail = solo@person.example.invalid\n");
  for (const name of [...TRAPPED, ...ALSO_TRAPPED]) {
    writeFileSync(join(trap, name), `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> '${trapLog}'\necho "the lab's trap: ${name} is never a real CLI on this machine" >&2\nexit 97\n`);
    chmodSync(join(trap, name), 0o755);
  }
  symlinkSync(process.execPath, join(tools, "node"));
  for (const name of ["npm", "npx", "git"]) {
    const found = onPath(name, hostPath);
    if (!found) throw new Error(`${name} is not on PATH`);
    symlinkSync(realpathSync(found), join(tools, name));
  }
  const path = [trap, tools, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
  for (const name of [...TRAPPED, ...ALSO_TRAPPED]) {
    if (onPath(name, path) !== join(trap, name)) throw new Error(`${name} does not resolve to the lab's trap on a clean machine`);
  }
  for (const name of ABSENT) {
    const found = onPath(name, path);
    if (found) throw new Error(`${name} resolves to ${found} on a clean machine's PATH`);
  }
  const env = labEnv(path, {
    HOME: home,
    TMPDIR: join(home, "tmp"),
    npm_config_cache: join(root, "npm-cache"),
    npm_config_registry: NO_REGISTRY,
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  });
  return { home, path, env, trapLog, trapped: () => trappedAt(root) };
}

/** Each call the trap of the clean machine made in `root` refused: the name called and its arguments. */
export function trappedAt(root: string): { name: string; args: string }[] {
  const log = join(root, "trap.log");
  return existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ name: line.split(" ")[0]!, args: line.slice(line.indexOf(" ") + 1) }))
    : [];
}

/** Whether nothing listens on this port on the loopback address. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** A port nothing listens on, from the system. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

/** Whether an address answers at all within a second. */
export async function answers(url: string): Promise<boolean> {
  return fetch(url, { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  );
}

/**
 * Settings every build since the rename reads. A build from before it holds none of them and reads
 * CONSOLE_CLAUDE_BIN instead, so a stale mirror's archive starts whatever claude is on PATH. The old
 * names themselves are in every build, kept to refuse them (server/old-settings.ts).
 */
export const RENAMED_READS = ["ORCHESTRATOR_CLAUDE_BIN", "ORCHESTRATOR_DATA_DIR", "ORCHESTRATOR_PORT"];

/**
 * What a packed tarball or a release archive installs: its name, its bins, any file whose path still
 * says console, and which of the settings a renamed build reads its code lacks. A release archive
 * holds one executable with the bundled code inside it, read as it is.
 */
export function packed(tarball: string, dir: string): { name: string; bins: string[]; oldNamePaths: string[]; missing: string[] } {
  mkdirSync(dir, { recursive: true });
  const unpacked = spawnSync("tar", ["-xzf", tarball, "-C", dir], { encoding: "utf8" });
  if (unpacked.status !== 0) throw new Error(`tar did not unpack ${tarball}: ${unpacked.stderr}`);
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const root = join(dir, entries.find((e) => e.name === "package")?.name ?? entries[0]?.name ?? "");
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(root.length + 1));
  const oldNamePaths = files.filter((f) => /console/i.test(f));
  const lacking = (code: string) => RENAMED_READS.filter((name) => !code.includes(name));
  if (existsSync(join(root, "package.json"))) {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; bin?: Record<string, string> };
    const code = files.filter((f) => /\.(m?js|cjs)$/.test(f)).map((f) => readFileSync(join(root, f), "utf8")).join("\n");
    return { name: manifest.name, bins: Object.keys(manifest.bin ?? {}).sort(), oldNamePaths, missing: lacking(code) };
  }
  const bins = files.filter((f) => /(^|\/)handbook-orchestrator[^/]*$/.test(f) && (statSync(join(root, f)).mode & 0o111) !== 0).sort();
  return { name: root.slice(dir.length + 1), bins, oldNamePaths, missing: lacking(bins.map((f) => readFileSync(join(root, f)).toString("latin1")).join("\n")) };
}
