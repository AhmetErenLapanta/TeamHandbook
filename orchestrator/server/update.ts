import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, sep } from "node:path";

/**
 * `handbook-orchestrator update [--check] [--to <version>] [--allow-downgrade] [--yes]`: moves an
 * install.sh install to another release the way install.sh would: the archive is checked against
 * SHA256SUMS, and SHA256SUMS against the release workflow's signature when cosign is installed,
 * before anything is written, unpacked and run beside its place, moved into
 * versions/<version> whole and made current in one rename. The version before stays, so going
 * back is `update --to <it> --allow-downgrade`. A service is restarted only on the person's yes.
 *
 * In two steps, `update --prepare` places the version and leaves current where it is, and
 * `update --apply` makes it current later. A version that failed to prepare is not tried again by
 * a plain `update --prepare`, only when it is named with --to, so a broken release does not
 * download and fail on every check.
 */

const REPOSITORY = "https://github.com/AhmetErenLapanta/TeamHandbook";
/** The release whose tag never moves and whose manifest.json names the newest version (install.sh says why). */
export const LATEST_RELEASE = `${REPOSITORY}/releases/download/handbook-orchestrator-latest`;
const versionRelease = (version: string) => `${REPOSITORY}/releases/download/handbook-orchestrator-v${version}`;
const signedBy = (version: string) => `${REPOSITORY}/.github/workflows/orchestrator-release.yml@refs/tags/handbook-orchestrator-v${version}`;
export const UPDATE_USAGE = "usage: handbook-orchestrator update [--check | --prepare | --apply] [--to <version>] [--allow-downgrade] [--yes]";

export interface UpdateHost {
  /** ~/.handbook-orchestrator */
  root: string;
  version: string;
  platform: string;
  /** A mirror holding every release file in one directory; null for the repository's releases. */
  mirror: string | null;
  /** The cosign on PATH, or null. */
  cosign: string | null;
  /** HANDBOOK_ORCHESTRATOR_REQUIRE_SIGNATURE=1: no release whose signature cosign has not checked. */
  requireSignature: boolean;
  fetch: (url: string) => Promise<{ ok: boolean; status: number; url: string; bytes: () => Promise<Buffer> }>;
  run: (command: string, args: string[]) => { code: number; out: string };
  /** The person's answer to a yes/no question; null where nobody can be asked. */
  ask: (question: string) => Promise<boolean | null>;
  /** Whether a service runs this install, and restarting it. */
  service: { installed: () => boolean; restart: () => number };
  say: (line: string) => void;
}

/** The order of two release versions, numbers compared as numbers; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.split("-", 2);
    return { parts: core.split(".").map((n) => Number(n) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** The release address rule install.sh holds to: https, and plain http on this machine only. */
export function releaseAddressAllowed(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const u = new URL(url);
  return u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname));
}

interface Options {
  check: boolean;
  prepare: boolean;
  apply: boolean;
  to: string | null;
  downgrade: boolean;
  yes: boolean;
}

export function parseUpdateArgs(args: readonly string[]): Options | null {
  const options: Options = { check: false, prepare: false, apply: false, to: null, downgrade: false, yes: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--check") options.check = true;
    else if (arg === "--prepare") options.prepare = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--allow-downgrade") options.downgrade = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--to" && args[i + 1] && /^[0-9A-Za-z.+-]+$/.test(args[i + 1]!)) options.to = args[++i]!;
    else return null;
  }
  if (Number(options.check) + Number(options.prepare) + Number(options.apply) > 1 || (options.apply && options.to)) return null;
  return options;
}

class UpdateRefused extends Error {}

/** What `update --prepare` left for `update --apply`, and the version that last failed to prepare. */
interface UpdateState {
  prepared?: { version: string };
  failed?: { version: string; reason: string };
}

const STATE_FILE = "update-state.json";

/** The state, or no update at all: a file that does not read as one this executable wrote is not guessed at. */
function readState(root: string): UpdateState {
  const file = join(root, STATE_FILE);
  if (!existsSync(file)) return {};
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    state = null;
  }
  const valid = (v: unknown) => typeof v === "string" && /^[0-9A-Za-z.+-]+$/.test(v);
  const s = state as { schema?: unknown; prepared?: { version?: unknown }; failed?: { version?: unknown; reason?: unknown } } | null;
  if (!s || s.schema !== 1 || (s.prepared && !valid(s.prepared.version)) || (s.failed && (!valid(s.failed.version) || typeof s.failed.reason !== "string"))) {
    throw new UpdateRefused(`${file} does not read as this executable's update state, so it updates nothing; remove the file to update again`);
  }
  return { ...(s.prepared ? { prepared: { version: s.prepared.version as string } } : {}), ...(s.failed ? { failed: { version: s.failed.version as string, reason: s.failed.reason as string } } : {}) };
}

function writeState(root: string, state: UpdateState): void {
  writeFileSync(join(root, STATE_FILE), JSON.stringify({ schema: 1, ...state }, null, 2) + "\n");
}

/** A file of the release, or null where the release has none. */
async function fetchFile(host: UpdateHost, url: string): Promise<Buffer | null> {
  let answer;
  try {
    answer = await host.fetch(url);
  } catch {
    throw new UpdateRefused(`could not reach ${url}`);
  }
  // A redirect is followed only to an address the same rule allows.
  if (!releaseAddressAllowed(answer.url)) throw new UpdateRefused(`${url} sent it on to ${answer.url}, which is not https`);
  if (answer.status === 404) return null;
  if (!answer.ok) throw new UpdateRefused(`${url} answered ${answer.status}`);
  return answer.bytes();
}

async function download(host: UpdateHost, url: string): Promise<Buffer> {
  const bytes = await fetchFile(host, url);
  if (!bytes) throw new UpdateRefused(`${url} does not exist`);
  return bytes;
}

/** SHA256SUMS against the signature of the release workflow run for this version's tag, as install.sh checks it. */
async function checkSignature(host: UpdateHost, base: string, version: string, sums: string, staging: string): Promise<void> {
  if (!host.cosign) {
    if (host.requireSignature) throw new UpdateRefused("HANDBOOK_ORCHESTRATOR_REQUIRE_SIGNATURE is 1 and cosign is not installed to check the signature");
    host.say("cosign is not installed, so the release signature was not checked; the checksums were");
    return;
  }
  const bundle = await fetchFile(host, `${base}/SHA256SUMS.sigstore.json`);
  if (!bundle) {
    if (host.mirror && !host.requireSignature) return void host.say("the mirror holds no SHA256SUMS.sigstore.json, so the signature was not checked; the checksums were");
    throw new UpdateRefused(`${base}/SHA256SUMS.sigstore.json does not exist; nothing was changed`);
  }
  writeFileSync(join(staging, "SHA256SUMS.sigstore.json"), bundle);
  const checked = host.run(host.cosign, ["verify-blob", "--bundle", join(staging, "SHA256SUMS.sigstore.json"), "--certificate-identity", signedBy(version), "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com", sums]);
  const last = checked.out.trim().split("\n").at(-1);
  if (checked.code !== 0) throw new UpdateRefused(`SHA256SUMS at ${base} is not signed by the release workflow for ${version}; nothing was changed${last ? ` (cosign: ${last})` : ""}`);
}

/** Unpacks and checks a version beside its place, then moves it in whole; the version's directory. */
async function place(host: UpdateHost, version: string): Promise<string> {
  const dest = join(host.root, "versions", version);
  if (existsSync(join(dest, ".install-complete"))) return dest;
  const base = host.mirror ?? versionRelease(version);
  const archive = `handbook-orchestrator-${version}-${host.platform}.tar.gz`;
  const sums = await download(host, `${base}/SHA256SUMS`);
  const staging = join(host.root, "versions", `.staging-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    writeFileSync(join(staging, "SHA256SUMS"), sums);
    await checkSignature(host, base, version, join(staging, "SHA256SUMS"), staging);
    const expected = sums.toString("utf8").split("\n").find((line) => line.endsWith(`  ${archive}`))?.slice(0, 64);
    if (!expected) throw new UpdateRefused(`release ${version} has no build for ${host.platform}`);
    const bytes = await download(host, `${base}/${archive}`);
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new UpdateRefused(`${archive} does not match its checksum in SHA256SUMS; nothing was changed`);
    writeFileSync(join(staging, archive), bytes);
    const unpacked = host.run("tar", ["-xzf", join(staging, archive), "-C", staging]);
    if (unpacked.code !== 0) throw new UpdateRefused(`${archive} did not unpack: ${unpacked.out.trim()}`);
    const dir = join(staging, `handbook-orchestrator-${version}-${host.platform}`);
    const said = host.run(join(dir, "handbook-orchestrator"), ["--version"]).out.trim();
    if (said !== `teamhandbook-orchestrator ${version}`) throw new UpdateRefused(`the unpacked executable does not run here (it said: ${said || "nothing"}); nothing was changed`);
    writeFileSync(join(dir, ".install-complete"), "");
    rmSync(dest, { recursive: true, force: true });
    renameSync(dir, dest);
    return dest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** current moves in one rename, so a running service never sees it missing. */
function makeCurrent(root: string, version: string): void {
  const next = join(root, "current.next");
  rmSync(next, { force: true });
  symlinkSync(join("versions", version), next);
  renameSync(next, join(root, "current"));
}

/** Keeps current, the version before it, and the newest one besides; older ones go. */
function prune(root: string, keep: readonly string[]): void {
  const dir = join(root, "versions");
  const versions = readdirSync(dir).filter((n) => !n.startsWith(".") && statSync(join(dir, n)).isDirectory());
  const kept = new Set([...keep, ...versions.sort(compareVersions).slice(-2)]);
  for (const v of versions) if (!kept.has(v)) rmSync(join(dir, v), { recursive: true, force: true });
}

/** The newest release manifest.json names: the one request a check makes. */
async function newest(host: UpdateHost): Promise<string> {
  const manifest = JSON.parse((await download(host, `${host.mirror ?? LATEST_RELEASE}/manifest.json`)).toString("utf8")) as { schema?: unknown; version?: unknown };
  if (manifest.schema !== undefined && manifest.schema !== 1) throw new UpdateRefused("the release's manifest.json is of a newer shape than this executable reads; install the newest with install.sh");
  if (typeof manifest.version !== "string" || !/^[0-9A-Za-z.+-]+$/.test(manifest.version)) throw new UpdateRefused("manifest.json names no version");
  return manifest.version;
}

/**
 * What the web's update row shows, read from the machine alone: the running version, the one
 * `update --prepare` left, and the one that last failed to prepare. No request leaves it.
 */
export function updateStatus(host: UpdateHost): { running: string; prepared: string | null; failed: { version: string; reason: string } | null } | { refused: string } {
  try {
    const state = readState(host.root);
    const prepared = state.prepared && existsSync(join(host.root, "versions", state.prepared.version, ".install-complete")) ? state.prepared.version : null;
    return { running: host.version, prepared, failed: state.failed ?? null };
  } catch (err) {
    if (err instanceof UpdateRefused) return { refused: err.message };
    throw err;
  }
}

/** Check for updates: the newest release, asked only when the person asks; nothing checks on its own. */
export async function checkForUpdate(host: UpdateHost): Promise<{ running: string; newest: string; newer: boolean } | { refused: string }> {
  if (host.mirror && !releaseAddressAllowed(host.mirror)) return { refused: `the release address has to be https (plain http only on this machine): ${host.mirror}` };
  try {
    const version = await newest(host);
    return { running: host.version, newest: version, newer: compareVersions(version, host.version) > 0 };
  } catch (err) {
    if (err instanceof UpdateRefused) return { refused: err.message };
    throw err;
  }
}

/** Makes `target` current, keeps the version before, and restarts a service on the person's yes. */
async function switchTo(host: UpdateHost, target: string, yes: boolean): Promise<number> {
  const previous = existsSync(join(host.root, "current")) ? readlinkSync(join(host.root, "current")).split(sep).pop()! : host.version;
  makeCurrent(host.root, target);
  prune(host.root, [target, previous]);
  const { prepared: _, ...rest } = readState(host.root);
  writeState(host.root, rest);
  host.say(`${target} is installed and current; ${previous} stays beside it (handbook-orchestrator update --to ${previous} --allow-downgrade goes back)`);
  // The new version copies a SQLite database before it moves the schema, so a restart is safe to take.
  if (host.service.installed()) {
    if (yes || (await host.ask("restart the service now, so it runs the new version?"))) return host.service.restart();
    host.say("the service runs the version before until it restarts: handbook-orchestrator service restart");
  } else host.say("an orchestrator running now keeps the version before until you start it again");
  return 0;
}

/** `update --apply`: the version `update --prepare` placed, made current. */
async function apply(host: UpdateHost, options: Options): Promise<number> {
  const { prepared } = readState(host.root);
  if (!prepared || !existsSync(join(host.root, "versions", prepared.version, ".install-complete"))) throw new UpdateRefused("no version is prepared; handbook-orchestrator update --prepare places the newest");
  const order = compareVersions(prepared.version, host.version);
  if (order === 0) {
    host.say(`${host.version} is installed already`);
    return 0;
  }
  if (order < 0 && !options.downgrade) throw new UpdateRefused(`${prepared.version} is older than ${host.version}; pass --allow-downgrade to go back to it`);
  return switchTo(host, prepared.version, options.yes);
}

export async function updateCommand(args: readonly string[], host: UpdateHost): Promise<number> {
  const options = parseUpdateArgs(args);
  if (!options) {
    host.say(UPDATE_USAGE);
    return 2;
  }
  if (host.mirror && !releaseAddressAllowed(host.mirror)) {
    host.say(`the release address has to be https (plain http only on this machine): ${host.mirror}`);
    return 1;
  }
  try {
    if (options.apply) return await apply(host, options);
    const state = readState(host.root);
    const target = options.to ?? (await newest(host));
    const order = compareVersions(target, host.version);
    if (options.check) {
      host.say(order > 0 ? `${host.version} is running; ${target} is out: handbook-orchestrator update moves to it` : `${host.version} is running, the newest there is`);
      return 0;
    }
    if (order === 0) {
      host.say(`${host.version} is installed already`);
      return 0;
    }
    if (order < 0 && !options.downgrade) throw new UpdateRefused(`${target} is older than ${host.version}; pass --allow-downgrade to go back to it`);
    if (options.prepare && !options.to && state.failed?.version === target) {
      throw new UpdateRefused(`${target} failed to prepare before (${state.failed.reason}), so it is not tried again; handbook-orchestrator update --prepare --to ${target} tries it`);
    }
    try {
      await place(host, target);
    } catch (err) {
      if (err instanceof UpdateRefused) writeState(host.root, { ...state, failed: { version: target, reason: err.message } });
      throw err;
    }
    const { failed: _, ...rest } = state;
    if (options.prepare) {
      writeState(host.root, { ...rest, prepared: { version: target } });
      host.say(`${target} is prepared beside ${host.version} and checked; handbook-orchestrator update --apply makes it current`);
      return 0;
    }
    writeState(host.root, rest);
    return await switchTo(host, target, options.yes);
  } catch (err) {
    if (err instanceof UpdateRefused) {
      host.say(err.message);
      return 1;
    }
    throw err;
  }
}

/** The version an executable inside an install runs: the versions/<version> directory it sits in. */
export function runningVersion(execPath: string, root: string): string | null {
  try {
    const versions = join(realpathSync(root), "versions") + sep;
    const real = realpathSync(execPath);
    return real.startsWith(versions) ? real.slice(versions.length).split(sep)[0]! : null;
  } catch {
    return null;
  }
}

/**
 * The update host of the install.sh install this process runs from, or null for an executable
 * install.sh did not place (a clone, npx, an archive unpacked by hand), which update leaves alone.
 * `ask` is the person's yes on a terminal; the web passes none and restarts on its own button.
 */
export function installedUpdateHost(options: { say: (line: string) => void; ask?: UpdateHost["ask"]; service: UpdateHost["service"]; execPath?: string; home?: string; env?: NodeJS.ProcessEnv }): UpdateHost | null {
  const { execPath = process.execPath, home = homedir(), env = process.env } = options;
  const root = installRoot(execPath, home);
  const version = root && runningVersion(execPath, root);
  if (!root || !version) return null;
  return {
    root,
    version,
    platform: `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
    mirror: env.HANDBOOK_ORCHESTRATOR_RELEASE_BASE_URL?.replace(/\/+$/, "") || null,
    cosign: onPath("cosign", env.PATH ?? ""),
    requireSignature: env.HANDBOOK_ORCHESTRATOR_REQUIRE_SIGNATURE === "1",
    fetch: async (url) => {
      const res = await fetch(url);
      return { ok: res.ok, status: res.status, url: res.url, bytes: async () => Buffer.from(await res.arrayBuffer()) };
    },
    run: runCommand,
    ask: options.ask ?? (async () => null),
    service: options.service,
    say: options.say,
  };
}

/** How a copy install.sh did not place was taken, so its owner is told the one way it updates. */
export type StartedFrom = { from: "clone"; folder: string } | { from: "npx" };

/** A clone is the repository's orchestrator/ beside its .git (a file in a worktree); npx runs from npm's _npx cache. */
export function startedFrom(packageRoot: string): StartedFrom | null {
  if (packageRoot.split(sep).includes("_npx")) return { from: "npx" };
  const folder = dirname(packageRoot);
  return basename(packageRoot) === "orchestrator" && existsSync(join(folder, ".git")) ? { from: "clone", folder } : null;
}

/** What `handbook-orchestrator update` says from a copy install.sh did not place. */
export function notInstalledUpdate(from: StartedFrom | null): string {
  if (from?.from === "clone") return `this orchestrator runs from a clone; in ${from.folder} run git pull, then npm start`;
  if (from?.from === "npx") return "this orchestrator runs through npx; npx teamhandbook-orchestrator@latest runs the newest release";
  return "this copy is updated the way it was taken: npx teamhandbook-orchestrator@latest runs the newest release, and a clone takes the newest with git pull";
}

/** Whether an executable path is inside an install.sh install, whose versions update can move. */
export function installRoot(execPath: string, home: string): string | null {
  const root = join(home, ".handbook-orchestrator");
  try {
    return realpathSync(execPath).startsWith(join(realpathSync(root), "versions") + sep) ? root : null;
  } catch {
    return null;
  }
}

/** The executable `name` resolves to on this PATH, or null. */
export function onPath(name: string, path: string = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {
      continue;
    }
  }
  return null;
}

/** The tar this process runs, for the host. */
export function runCommand(command: string, args: string[]): { code: number; out: string } {
  const done = spawnSync(command, args, { encoding: "utf8" });
  return { code: done.status ?? 1, out: `${done.stdout ?? ""}${done.stderr ?? ""}` };
}
