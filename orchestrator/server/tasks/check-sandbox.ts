import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { onPath } from "../update.js";
import type { Invocation } from "./isolation.js";

/**
 * The places under a person's home a check reads again, read-only, inside a home otherwise kept from
 * it: the caches and toolchains a build reaches by absolute path. HOME itself points at the task's own.
 */
export const TOOL_PLACES = [
  ".npm",
  ".cache",
  ".yarn",
  ".pnpm-store",
  ".nvm",
  ".volta",
  ".bun",
  ".deno",
  ".pyenv",
  ".rbenv",
  ".asdf",
  ".sdkman",
  ".rustup",
  ".cargo/bin",
  ".cargo/registry",
  ".m2",
  ".gradle",
  "go/pkg",
  "go/bin",
  ".local/bin",
  ".local/lib",
  ".local/pipx",
  ".local/share/pnpm",
  ".npm-global",
  "Library/Caches",
  "Library/pnpm",
];

/**
 * Where a person keeps what signs them in: hidden again inside a reopened tool place, so a cache that
 * holds one gives none of it to a check, which runs code the agent may have written.
 */
export const CREDENTIAL_PLACES = [
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".docker",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".password-store",
  ".vault-token",
  ".terraform.d",
  ".gem/credentials",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".local/share/keyrings",
  ".cache/huggingface",
  ".cache/gh",
  ".cache/pip/http",
  ".huggingface",
  ".claude",
  ".claude.json",
  ".teamhandbook",
  ".config",
  "Library/Keychains",
];

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * What a check sees, in layers, each later one winning over the earlier: `hidden` is kept from it
 * whole (the person's home, the orchestrator's data directory); `tools` opens again read-only inside
 * those; `secrets` is hidden again inside the tools; `readable` and `writable` are the task's own
 * directories, opened last, read-only and writable.
 */
export interface CheckPlaces {
  hidden: string[];
  tools: string[];
  secrets: string[];
  readable: string[];
  writable: string[];
}

export type CheckSandbox = { tool: "seatbelt" | "bwrap"; program: string } | { refused: string };

/** The places as the kernel sees them, real paths only: macOS matches /private/var, never /var, and a place not on disk needs no rule. */
async function resolved(places: CheckPlaces): Promise<CheckPlaces> {
  const kept = async (paths: string[]) => [...new Set((await Promise.all(paths.map((p) => realpath(p).catch(() => null)))).filter((p): p is string => p !== null))];
  return { hidden: await kept(places.hidden), tools: await kept(places.tools), secrets: await kept(places.secrets), readable: await kept(places.readable), writable: await kept(places.writable) };
}

/**
 * A check's places for a task: the task's directories open, the person's home and the data directory
 * kept from it, the tool places open again with the sign-in places hidden inside them. Each directory
 * on the person's PATH under their home opens too, read-only and alone: a `~/code/bin` on the PATH
 * opens that `bin`, never `~/code` and the other projects in it. A toolchain's own root comes back
 * only through `TOOL_PLACES`. On Linux `/tmp` and the person's runtime directory, where agent and keyring
 * sockets live, are emptied as well; seatbelt refuses those sockets itself.
 */
export function checkPlaces(task: { work: string; tmp: string; home: string; git: string }, person: { home: string | undefined; path: string | undefined }, dataDir: string, platform: NodeJS.Platform = process.platform): CheckPlaces {
  const home = person.home;
  const under = (path: string) => Boolean(home) && path.startsWith(`${home}/`);
  const onPath = (person.path ?? "").split(":").filter(under);
  const runtime = platform === "linux" ? ["/tmp", ...(process.getuid ? [`/run/user/${process.getuid()}`] : [])] : [];
  return {
    hidden: [...(home ? [home] : []), dataDir, ...runtime],
    tools: home ? [...TOOL_PLACES.map((place) => join(home, place)), ...onPath] : [],
    secrets: home ? CREDENTIAL_PLACES.map((place) => join(home, place)) : [],
    readable: [task.git],
    writable: [task.work, task.tmp, task.home],
  };
}

/**
 * The seatbelt profile a check runs under on macOS, its places layered as `CheckPlaces` says, with
 * the keychain's service and every unix socket outside the task's own directories refused (an
 * ssh-agent's, a keyring's), name lookups' own socket aside; writes go only to the task's directories
 * and the standard streams. In seatbelt a later rule wins, which is what lets a layer open inside another.
 */
export function seatbeltProfile(places: CheckPlaces): { profile: string; params: string[] } {
  const params: string[] = [];
  const names = (kind: string, paths: string[]) =>
    paths.map((path, i) => {
      params.push("-D", `${kind}${i}=${path}`);
      return `(subpath (param "${kind}${i}"))`;
    });
  const rule = (paths: string[], make: (filters: string) => string) => (paths.length ? [make(paths.join(" "))] : []);
  const hidden = names("HIDE", places.hidden);
  const tools = names("TOOL", places.tools);
  const secrets = names("SECRET", places.secrets);
  const readable = names("READ", places.readable);
  const writable = names("WRITE", places.writable);
  const above = [...new Set([...places.writable, ...places.readable, ...places.tools].flatMap((path) => {
    const dirs: string[] = [];
    for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) dirs.push(dir);
    return dirs;
  }))].map((path, i) => {
    params.push("-D", `UP${i}=${path}`);
    return `(literal (param "UP${i}"))`;
  });
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/fd/") (regex #"^/dev/tty"))',
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.security.agent"))',
    "(deny network-outbound (remote unix-socket))",
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    ...rule(hidden, (f) => `(deny file-read* file-write* ${f})`),
    ...rule(tools, (f) => `(allow file-read* ${f})`),
    ...rule(secrets, (f) => `(deny file-read* file-write* ${f})`),
    ...rule(above, (f) => `(allow file-read-metadata ${f})`),
    ...rule(readable, (f) => `(allow file-read* ${f})`),
    ...rule(writable, (f) => `(allow file-read* file-write* ${f})`),
    ...rule(writable, (f) => `(allow network-outbound (remote unix-socket ${f}))`),
  ].join("\n");
  return { profile, params };
}

/**
 * bubblewrap's arguments for a check on Linux: the whole file system read-only, then the layers of
 * `CheckPlaces` in order: a hidden directory an empty one and a hidden file empty, a tool place and
 * the task's git directory bound back read-only, the task's own directories bound back writable.
 */
export function bwrapArgs(places: CheckPlaces, dirs: ReadonlySet<string>): string[] {
  const hide = (paths: string[]) => paths.flatMap((path) => (dirs.has(path) ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path]));
  return [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    ...hide(places.hidden),
    ...places.tools.flatMap((path) => ["--ro-bind", path, path]),
    ...hide(places.secrets),
    ...places.readable.flatMap((path) => ["--ro-bind", path, path]),
    ...places.writable.flatMap((path) => ["--bind", path, path]),
    "--die-with-parent",
  ];
}

/** Whether `program` with `args` starts a sandbox here at all: a nested sandbox, or a kernel that keeps user namespaces off, refuses before any check runs. */
function starts(program: string, args: string[]): Promise<boolean> {
  return new Promise((done) => execFile(program, args, { timeout: 10_000 }, (err) => done(!err)));
}

/** The sandbox tool for checks on this machine, found once: seatbelt on macOS, bubblewrap on Linux; a machine with neither runs no check, and the task says why. */
export async function findCheckSandbox(platform: NodeJS.Platform = process.platform, path: string | undefined = process.env.PATH): Promise<CheckSandbox> {
  if (platform === "darwin") {
    if (!(await access(SANDBOX_EXEC).then(() => true, () => false)) || !(await starts(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"]))) return { refused: "sandbox-exec, which keeps a check out of your sign-ins and from writing outside the task, does not start on this Mac" };
    return { tool: "seatbelt", program: SANDBOX_EXEC };
  }
  if (platform === "linux") {
    const bwrap = onPath("bwrap", path ?? "");
    if (!bwrap) return { refused: "bubblewrap (bwrap), which keeps a check out of your sign-ins and from writing outside the task, is not installed; install it to run the checks" };
    if (!(await starts(bwrap, ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"]))) return { refused: "bubblewrap (bwrap) does not start a sandbox on this machine, as it needs user namespaces the kernel keeps off" };
    return { tool: "bwrap", program: bwrap };
  }
  return { refused: `no sandbox for a check is known on ${platform}` };
}

/** A check's command as it runs inside the sandbox, kept to `places`. */
export async function sandboxed(box: Exclude<CheckSandbox, { refused: string }>, places: CheckPlaces, inv: Invocation): Promise<Invocation> {
  const at = await resolved(places);
  if (box.tool === "seatbelt") {
    const { profile, params } = seatbeltProfile(at);
    return { ...inv, program: box.program, args: ["-p", profile, ...params, inv.program, ...inv.args] };
  }
  // bubblewrap empties a hidden directory and blanks a hidden file: which one each is, read before the check runs.
  const hidden = [...at.hidden, ...at.secrets];
  const dirs = new Set((await Promise.all(hidden.map(async (p) => ((await stat(p).catch(() => null))?.isDirectory() ? p : null)))).filter((p): p is string => p !== null));
  return { ...inv, program: box.program, args: [...bwrapArgs(at, dirs), "--chdir", inv.cwd, "--", inv.program, ...inv.args] };
}
