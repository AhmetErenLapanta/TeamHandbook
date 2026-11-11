import { declaredServers, detectSecret } from "./plugin.js";
import type { ScanFinding } from "./pending-scan.js";

/**
 * What a waiting request brings into every teammate's session from outside the team: a package
 * fetched at whatever version is newest when it runs, a script downloaded and run, a tool grant
 * as wide as the shell, an address nobody on the team has used before. Each is read from the
 * lines the request adds, and said with the line it was found on.
 */
export type SupplyCheck = "unpinned-package" | "remote-exec" | "broad-tools" | "new-domain";

/** Where a request changes what runs in a teammate's session; elsewhere these lines are the team's own code. */
export function isAgentPath(path: string): boolean {
  return /^(skills|commands|hooks|agents|\.claude-plugin|\.claude)\//.test(path) || path === ".mcp.json";
}

const RUNNERS = /(?:^|[\s;&|("'`])(npx|bunx|uvx|pnpm\s+dlx|yarn\s+dlx)\s+([^\n;&|`]*)/g;
const VALUE_FLAGS = new Set(["--from", "--package", "-p", "--with"]);

/** The package a runner fetches and whether its version is fixed: `name@1.2.3`, `name==1.2.3`, never `@latest` or none. */
function packageOf(args: string): { name: string; pinned: boolean; latest: boolean } | null {
  const words = args.split(/\s+/).filter(Boolean).map((w) => w.replace(/^["']|["',]$/g, ""));
  let name: string | undefined;
  for (let i = 0; i < words.length; i++) {
    if (VALUE_FLAGS.has(words[i]!)) {
      name = words[i + 1];
      break;
    }
    if (!words[i]!.startsWith("-")) {
      name = words[i];
      break;
    }
  }
  if (!name || name.startsWith("$")) return null;
  const at = name.indexOf("@", name.startsWith("@") ? 1 : 0);
  const version = name.includes("==") ? name.split("==")[1]! : at > 0 ? name.slice(at + 1) : "";
  const latest = /^(latest|next|canary)$/i.test(version);
  return { name, latest, pinned: /^[0-9^~=v]/.test(version) && !latest };
}

const REMOTE_EXEC = [
  /\b(curl|wget)\b[^\n|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/,
  /\b(curl|wget)\b[^\n|;&]*\|\s*(sudo\s+)?(python3?|node|perl|ruby)\b/,
  /\b(ba|z)?sh\s+(-c\s+)?["']?\$\(\s*(curl|wget)\b/,
  /\b(ba|z)?sh\s+<\(\s*(curl|wget)\b/,
  /\b(iex|invoke-expression)\b.*\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b/i,
];

/** A tool grant that is the whole shell, or every tool. */
function broadGrant(line: string): boolean {
  if (/"Bash(\(\s*:?\*\s*\))?"/.test(line)) return true;
  const grant = /^\s*allowed-tools\s*:(.*)$/i.exec(line)?.[1];
  if (grant === undefined) return false;
  return grant.split(/[,\s[\]]+/).some((t) => /^(Bash|Bash\(\s*:?\*\s*\)|\*)$/.test(t.replace(/["']/g, "")));
}

const RESERVED = /(^|\.)(localhost|invalid|test|example|local)$|^(example\.(com|org|net)|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])$/;

/** The hosts of the http(s) addresses in a text, lower-cased. */
export function hostsIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/(?:[^/\s@"'<>]*@)?([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])/g)].map((m) => m[1]!.toLowerCase().replace(/\.$/, ""));
}

/** A line as a finding shows it: on its own, short, with any password in an address masked, and none at all when it looks like it holds a secret. */
export function shownLine(line: string): string {
  if (detectSecret(line)) return "(not shown: the line looks like it holds a secret)";
  const masked = line.trim().replace(/(\w+:\/\/)[^/@\s]+@/g, "$1***@");
  return masked.length > 200 ? `${masked.slice(0, 199)}…` : masked;
}

function lineChecks(line: string, known: ReadonlySet<string>): { check: SupplyCheck; risk: "high" | "medium"; detail: string }[] {
  const found: { check: SupplyCheck; risk: "high" | "medium"; detail: string }[] = [];
  if (REMOTE_EXEC.some((re) => re.test(line))) found.push({ check: "remote-exec", risk: "high", detail: "downloads a script and runs it as it arrives, on every teammate's machine" });
  for (const m of line.matchAll(RUNNERS)) {
    const pkg = packageOf(m[2]!);
    if (pkg && !pkg.pinned) found.push({ check: "unpinned-package", risk: "medium", detail: `${m[1]!.replace(/\s+/, " ")} runs ${pkg.name}${pkg.latest ? "" : " at no fixed version"}, so each run takes whatever was published last` });
  }
  if (broadGrant(line)) found.push({ check: "broad-tools", risk: "high", detail: "grants the whole shell or every tool without asking" });
  const fresh = [...new Set(hostsIn(line))].filter((h) => !known.has(h) && !RESERVED.test(h));
  if (fresh.length) found.push({ check: "new-domain", risk: "medium", detail: `reaches ${fresh.join(", ")}, which nothing in the repository reached before` });
  return found;
}

/**
 * The supply-chain findings for one file a request changes, from the lines it adds. A server in
 * .mcp.json is read as the command line it starts, since its command and arguments sit on lines
 * of their own; the finding names the line its entry starts on.
 */
export function supplyChainFindings(path: string, content: string, before: string | null, known: ReadonlySet<string>): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = content.split(/\r?\n/);
  if (path === ".mcp.json") {
    const was = declaredServers(before);
    for (const [name, config] of Object.entries(declaredServers(content))) {
      if (JSON.stringify(was[name]) === JSON.stringify(config)) continue;
      const entry = config as { command?: unknown; args?: unknown; url?: unknown };
      const commandLine = [entry.command, ...(Array.isArray(entry.args) ? entry.args : []), entry.url].filter((p): p is string => typeof p === "string").join(" ");
      const at = lines.findIndex((l) => l.includes(JSON.stringify(name)));
      for (const f of lineChecks(commandLine, known)) findings.push({ level: "attention", path, ...f, line: at + 1, evidence: shownLine(commandLine), detail: `the server ${name} ${f.detail}` });
    }
    return findings;
  }
  const kept = new Set((before ?? "").split(/\r?\n/));
  lines.forEach((line, i) => {
    if (kept.has(line)) return;
    for (const f of lineChecks(line, known)) findings.push({ level: "attention", path, ...f, line: i + 1, evidence: shownLine(line) });
  });
  return findings;
}
