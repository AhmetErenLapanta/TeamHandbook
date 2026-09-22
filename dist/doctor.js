// src/lib/doctor.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync3, mkdirSync as mkdirSync4, readdirSync as readdirSync3, readFileSync as readFileSync6, rmSync as rmSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join8 } from "node:path";

// src/lib/session-state.ts
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
var EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}
function handbookWorkdir(prefix, home = handbookHome()) {
  try {
    const root = join(home, "tmp");
    mkdirSync(root, { recursive: true });
    return mkdtempSync(join(root, prefix));
  } catch {
    return mkdtempSync(join(tmpdir(), prefix));
  }
}
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var SESSION_ORPHAN_MS = 3 * 60 * 60 * 1e3;

// src/lib/counters.ts
import { mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
var FIELDS = [
  "redactionBlocked",
  "postToolUse",
  "bashFailuresCaptured",
  "pairsResolved",
  "gateErrors",
  "gateAbandoned"
];
function countersFile(home = handbookHome()) {
  return join2(home, "counters.json");
}
function readCounters(home = handbookHome()) {
  const base = {
    redactionBlocked: 0,
    postToolUse: 0,
    bashFailuresCaptured: 0,
    pairsResolved: 0,
    gateErrors: 0,
    gateAbandoned: 0
  };
  try {
    const parsed = JSON.parse(readFileSync2(countersFile(home), "utf8"));
    for (const f of FIELDS) base[f] = Number(parsed?.[f]) || 0;
  } catch {
  }
  return base;
}

// src/lib/init.ts
import { homedir as homedir3 } from "node:os";
import { dirname, join as join4 } from "node:path";

// src/lib/config.ts
import { existsSync, readFileSync as readFileSync3 } from "node:fs";
import { join as join3 } from "node:path";
function configFile(home = handbookHome()) {
  return join3(home, "config.json");
}
function readConfigFile(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync3(configFile(home), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function configIsBroken(home = handbookHome()) {
  const file = configFile(home);
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync3(file, "utf8"));
    return !(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  } catch {
    return true;
  }
}

// src/lib/score.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var defaultScoreConfig = {
  model: "haiku",
  threshold: 7,
  timeoutMs: 6e4
};
function loadScoreConfig(home = handbookHome()) {
  const gate = readConfigFile(home).gate;
  return {
    model: typeof gate?.model === "string" ? gate.model : defaultScoreConfig.model,
    threshold: typeof gate?.threshold === "number" && gate.threshold >= 0 && gate.threshold <= 10 ? gate.threshold : defaultScoreConfig.threshold,
    timeoutMs: typeof gate?.timeoutMs === "number" && gate.timeoutMs > 0 ? gate.timeoutMs : defaultScoreConfig.timeoutMs
  };
}

// src/lib/distill.ts
var defaultDistillConfig = {
  model: "",
  timeoutMs: 12e4
};
function loadDistillConfig(home = handbookHome()) {
  const distill = readConfigFile(home).distill;
  return {
    model: typeof distill?.model === "string" ? distill.model : defaultDistillConfig.model,
    timeoutMs: typeof distill?.timeoutMs === "number" && distill.timeoutMs > 0 ? distill.timeoutMs : defaultDistillConfig.timeoutMs
  };
}
function normalizeRemoteUrl(raw) {
  let s = raw.trim();
  if (!s) return null;
  if (/[\x00-\x1f\x7f]/.test(s)) return null;
  const hadProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.replace(/^[^@/]+@/, "");
  if (!hadProtocol) {
    const colon = s.indexOf(":");
    const slash2 = s.indexOf("/");
    if (colon > 0 && (slash2 === -1 || colon < slash2)) {
      s = s.slice(0, colon) + "/" + s.slice(colon + 1);
    }
  }
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  const slash = s.indexOf("/");
  if (slash <= 0 || slash === s.length - 1) return null;
  return s.slice(0, slash).toLowerCase() + s.slice(slash);
}

// src/lib/forge.ts
function hostFromUrl(url) {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return null;
  return normalized.slice(0, normalized.indexOf("/"));
}

// src/lib/display-path.ts
import { homedir as homedir2 } from "node:os";
import { sep } from "node:path";
function displayPath(path, userHome = homedir2()) {
  if (typeof path !== "string") return String(path);
  if (!userHome) return path;
  if (path === userHome) return "~";
  if (path.startsWith(userHome + sep)) return `~${path.slice(userHome.length)}`;
  return path;
}

// src/lib/init.ts
function loadTeamConfig(home = handbookHome()) {
  const team = readConfigFile(home).team;
  if (team && typeof team.repoUrl === "string" && typeof team.marketplaceName === "string") {
    return team;
  }
  return null;
}
var BUMP_SCRIPT = `import { readFileSync, writeFileSync } from "node:fs";

const file = ".claude-plugin/plugin.json";
const plugin = JSON.parse(readFileSync(file, "utf8"));
const parts = plugin.version.split(".").map(Number);
parts[2] += 1;
plugin.version = parts.join(".");
writeFileSync(file, JSON.stringify(plugin, null, 2) + "\\n");
console.log(\`bumped plugin version to \${plugin.version}\`);
`;
var githubWorkflow = (bump) => `name: version-bump

# Bumps the plugin version on every merge to main. The version string is Claude Code's
# update signal: without a bump, teammates keep serving the cached marketplace copy.
on:
  push:
    branches: [main]

jobs:
  bump:
    if: "!startsWith(github.event.head_commit.message, '${bump}')"
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: node scripts/bump-version.mjs
      - run: |
          git config user.name "handbook-ci"
          git config user.email "handbook-ci@users.noreply.github.com"
          git commit -am "${bump}"
          git push
`;
var gitlabCi = (bump) => `# Bumps the plugin version on every merge to the default branch. The version string is
# Claude Code's update signal: without a bump, teammates keep serving the cached copy.
# Requires a project access token with write_repository scope stored in the
# TEAMHANDBOOK_CI_TOKEN CI/CD variable (Settings > CI/CD > Variables).
version-bump:
  image: node:20
  rules:
    # only run when the CI token exists - otherwise skip (don't fail the pipeline)
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_COMMIT_MESSAGE !~ /^${bump}/ && $TEAMHANDBOOK_CI_TOKEN'
  script:
    - node scripts/bump-version.mjs
    - git config user.name "handbook-ci"
    - git config user.email "handbook-ci@noreply.invalid"
    - git commit -am "${bump}"
    - git push "https://oauth2:\${TEAMHANDBOOK_CI_TOKEN}@\${CI_SERVER_HOST}/\${CI_PROJECT_PATH}.git" "HEAD:\${CI_DEFAULT_BRANCH}"
`;
function readmeFor(name, url) {
  return `# ${name}

Your team's shared setup: skills, MCP servers, and slash commands your team has
approved through TeamHandbook. This repository is a Claude Code plugin marketplace;
every merge reaches all subscribed teammates automatically.

## Access

If this repository is private, each teammate needs two separate things: access to the
repository (ask whoever set it up), and git credentials on their own machine. The second
is a one-time interactive sign-in they run themselves, for example
\`brew install gh && gh auth login\` for GitHub over HTTPS, or an SSH key registered with
the forge. Without it the commands below fail with a bare git error, because a plugin
can never stop to ask for a password.

## Consume the handbook (no TeamHandbook needed)

\`\`\`
/plugin marketplace add ${url}
/plugin install ${name}@${name}
\`\`\`

## Produce for the handbook (TeamHandbook engine required)

\`\`\`
/handbook:join ${url}
\`\`\`

## How updates flow

Every skill arrives as a merge request that also raises the version in
\`.claude-plugin/plugin.json\`. That version is Claude Code's signal that the plugin
moved: merge the request and each teammate's marketplace copy refreshes on its own.
Skills live under \`skills/\`, one directory per skill (\`SKILL.md\` plus the
\`grounded-case.json\` evidence it was distilled from).

Nothing here needs CI, an access token, or the right to push to a protected branch. If
skills also arrive by hand in this repository, \`/handbook:init --with-ci\` scaffolds a
job that bumps the version on merge instead, together with the script it runs.

This plugin ships a tiny dependency-free SessionStart hook that shows consumers a
"N new skills/servers/commands" notice; it records what it has already shown you under
\`~/.teamhandbook-consumer\` (remove it any time with \`rm -rf ~/.teamhandbook-consumer\`).
It makes no network calls and needs no TeamHandbook engine.
`;
}
var CONSUMER_NOTICE_HOOKS = JSON.stringify(
  {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/notice.mjs"' }] }
      ]
    }
  },
  null,
  2
);
var CONSUMER_NOTICE_SCRIPT = `#!/usr/bin/env node
// Prints "<plugin>: N new skill(s) since your last session" - no dependencies, no
// TeamHandbook engine required. Best-effort: any error exits 0 silently.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
try {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  let name = "team-skills";
  try { name = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).name || name; } catch {}
  const current = readdirSync(join(root, "skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  // A merged MCP server raises the plugin version and refreshes every copy exactly as a
  // skill does. Counting only skills would make that arrive in silence: the teammate
  // would have a new server connected to their machine and no notice that it happened,
  // which is half of what this plugin promises. Both shapes seen in the field are read
  // here - a {"mcpServers": {...}} wrapper and a bare server map - and this deliberately
  // duplicates the reader in TeamHandbook's own mcp.ts, because this script ships inside
  // the team's plugin and is not allowed to import anything.
  let servers = [];
  try {
    const parsed = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    const map = parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers ? parsed.mcpServers : parsed;
    if (map && typeof map === "object") servers = Object.keys(map).sort();
  } catch {}
  // Slash commands merge the same way a skill or server does - one MR, one version bump,
  // every subscribed copy refreshed - so they get the same notice. Read directly from
  // commands/*.md rather than importing TEAM_COMMANDS_DIR, for the same reason mcp.ts is
  // not imported above: this script ships inside the team's plugin, with no dependencies.
  let commands = [];
  try {
    commands = readdirSync(join(root, "commands"), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name.slice(0, -3))
      .sort();
  } catch {}
  const seenDir = join(homedir(), ".teamhandbook-consumer");
  const seenFile = join(seenDir, name + ".json");
  let prior = null;
  try { prior = JSON.parse(readFileSync(seenFile, "utf8")); } catch {}
  mkdirSync(seenDir, { recursive: true });
  writeFileSync(seenFile, JSON.stringify({ skills: current, servers, commands }));
  // An earlier copy of this script stored a bare array of skill names. Reading that as
  // "no servers seen yet" would announce every server the team already had as new, so
  // the one session after an upgrade reports skills only.
  const priorSkills = Array.isArray(prior) ? prior : prior && Array.isArray(prior.skills) ? prior.skills : null;
  const priorServers = Array.isArray(prior) ? servers : prior && Array.isArray(prior.servers) ? prior.servers : null;
  // Same problem one field later: a record written before commands existed (bare array,
  // or the {skills, servers} shape) has no .commands at all. Falling back to the current
  // list rather than null means "nothing seen yet" is never mistaken for "everything is
  // new" - it reads as an empty diff instead, exactly like priorServers above.
  const priorCommands = Array.isArray(prior) ? commands : prior && Array.isArray(prior.commands) ? prior.commands : commands;
  const freshSkills = priorSkills ? current.filter((s) => !priorSkills.includes(s)) : [];
  const freshServers = priorServers ? servers.filter((s) => !priorServers.includes(s)) : [];
  const freshCommands = commands.filter((c) => !priorCommands.includes(c));
  const parts = [];
  if (freshSkills.length) parts.push(freshSkills.length + " new skill(s)");
  if (freshServers.length) parts.push(freshServers.length + " new MCP server(s)");
  if (freshCommands.length) parts.push(freshCommands.length + " new command(s)");
  // "X and Y" reads fine, but a skill and a server and a command in the same session
  // only became possible once commands joined this notice, and "X and Y and Z" is not
  // how English lists three things. The Oxford comma before the last item is what makes
  // three (or more) read naturally; two items still just get "X and Y".
  function englishList(items) {
    if (items.length < 3) return items.join(" and ");
    return items.slice(0, -1).join(", ") + ", and " + items[items.length - 1];
  }
  if (parts.length) {
    // A plugin's own commands are typed as /<plugin-name>:<command-name>, not bare
    // /<command-name> - Claude Code namespaces every installed plugin's commands this
    // way, and this repo's own README (and share.ts's post-share message) never shows
    // a bare form. Printing the bare name here would hand the teammate a command that
    // does not resolve, defeating the point of announcing it at all.
    const named = freshSkills
      .concat(freshServers.map((s) => s + " (MCP)"))
      .concat(freshCommands.map((c) => "/" + name + ":" + c))
      .join(", ");
    console.log(name + ": " + englishList(parts) + " since your last session: " + named + ".");
  }
} catch {}
process.exit(0);
`;
function skeletonFiles(name, url, host, commitPrefix = "", withCi = false) {
  const files = {
    "hooks/hooks.json": CONSUMER_NOTICE_HOOKS + "\n",
    "hooks/notice.mjs": CONSUMER_NOTICE_SCRIPT,
    ".claude-plugin/marketplace.json": JSON.stringify(
      {
        name,
        owner: { name: `${name} maintainers` },
        plugins: [
          {
            name,
            source: "./",
            description: "Skills, MCP servers, and slash commands your team has approved through TeamHandbook."
          }
        ]
      },
      null,
      2
    ) + "\n",
    ".claude-plugin/plugin.json": JSON.stringify(
      {
        name,
        description: "Skills, MCP servers, and slash commands your team has approved through TeamHandbook.",
        version: "0.1.0"
      },
      null,
      2
    ) + "\n",
    "README.md": readmeFor(name, url),
    "skills/README.md": "Approved skills land here, one directory per skill (SKILL.md + grounded-case.json).\n"
  };
  if (withCi) {
    files["scripts/bump-version.mjs"] = BUMP_SCRIPT;
    const bump = `${commitPrefix}ci: bump plugin version`;
    if (host && host.includes("github")) {
      files[".github/workflows/version-bump.yml"] = githubWorkflow(bump);
    } else {
      files[".gitlab-ci.yml"] = gitlabCi(bump);
    }
  }
  return files;
}
function marketplacesRoot() {
  return join4(homedir3(), ".claude", "plugins", "marketplaces");
}

// src/lib/upgrade.ts
import { existsSync as existsSync2, lstatSync, mkdirSync as mkdirSync3, readFileSync as readFileSync4, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join5, relative } from "node:path";
var PLUGIN_MANIFEST = ".claude-plugin/plugin.json";
var MARKETPLACE_MANIFEST = ".claude-plugin/marketplace.json";
var CI_MARKER = "scripts/bump-version.mjs";
var TEAM_OWNED_DIRS = ["skills/", "commands/", "agents/"];
var TEAM_OWNED_FILES = [".mcp.json"];
function isTeamOwned(path) {
  return TEAM_OWNED_DIRS.some((dir) => path.startsWith(dir)) || TEAM_OWNED_FILES.includes(path);
}
function readIfPresent(file) {
  try {
    return readFileSync4(file, "utf8");
  } catch {
    return null;
  }
}
function symlinkOnPath(repoDir, path) {
  let current = repoDir;
  for (const part of path.split("/")) {
    current = join5(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return relative(repoDir, current);
  }
  return null;
}
function parseObject(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
function mergePluginManifest(existing, fresh) {
  if (existing === null) return fresh;
  const current = parseObject(existing);
  if (!current) return null;
  const next = JSON.parse(fresh);
  const merged = { ...current, ...next };
  if (typeof current.version === "string") merged.version = current.version;
  return JSON.stringify(merged, null, 2) + "\n";
}
function isOwnPlugin(entry) {
  return typeof entry === "object" && entry !== null && entry.source === "./";
}
function mergeMarketplaceManifest(existing, fresh) {
  if (existing === null) return fresh;
  const current = parseObject(existing);
  if (!current) return null;
  const next = JSON.parse(fresh);
  const merged = { ...current };
  for (const [key, value] of Object.entries(next)) if (!(key in merged)) merged[key] = value;
  const own = next.plugins?.find(isOwnPlugin);
  if (Array.isArray(current.plugins) && own) {
    let found = false;
    const kept = current.plugins.map((entry) => {
      if (!isOwnPlugin(entry)) return entry;
      found = true;
      return { ...entry, ...own };
    });
    merged.plugins = found ? kept : [...current.plugins, own];
  }
  return JSON.stringify(merged, null, 2) + "\n";
}
var PREFIX_PROBE = "ZZTEAMHANDBOOKPREFIXPROBEZZ";
function commitPrefixIsKnown(team) {
  if (typeof team.commitPrefix === "string") return true;
  return !!team.initializedAt;
}
function prefixDependentPaths(team, withCi) {
  const host = hostFromUrl(team.repoUrl);
  const plain = skeletonFiles(team.marketplaceName, team.repoUrl, host, "", withCi);
  const probed = skeletonFiles(team.marketplaceName, team.repoUrl, host, PREFIX_PROBE, withCi);
  return new Set(Object.keys(plain).filter((path) => plain[path] !== probed[path]));
}
function upgradeCandidates(repoDir, team) {
  const withCi = existsSync2(join5(repoDir, CI_MARKER));
  const generated = skeletonFiles(
    team.marketplaceName,
    team.repoUrl,
    hostFromUrl(team.repoUrl),
    team.commitPrefix?.trim() ?? "",
    withCi
  );
  const unknownPrefix = commitPrefixIsKnown(team) ? /* @__PURE__ */ new Set() : prefixDependentPaths(team, withCi);
  const files = {};
  const linked = [];
  const withheld = [];
  for (const [path, content] of Object.entries(generated)) {
    if (isTeamOwned(path)) continue;
    const link = symlinkOnPath(repoDir, path);
    if (link) {
      linked.push({
        path,
        reason: `the repository carries a symbolic link at "${link}". Nothing in the scaffold is a link, so this is not a file a refresh can write, and following it would write outside the repository.`
      });
      continue;
    }
    if (unknownPrefix.has(path)) {
      withheld.push({
        path,
        reason: "it embeds the team's commit-message prefix, which only the machine that ran /handbook:init recorded. Regenerating it here would drop that prefix and stop the team's version bumps, so it is not offered on this machine."
      });
      continue;
    }
    const merged = path === PLUGIN_MANIFEST ? mergePluginManifest(readIfPresent(join5(repoDir, path)), content) : path === MARKETPLACE_MANIFEST ? mergeMarketplaceManifest(readIfPresent(join5(repoDir, path)), content) : content;
    if (merged !== null) files[path] = merged;
  }
  return { files, linked, withheld };
}
function classify(repoDir, candidates) {
  return Object.entries(candidates).map(([path, content]) => {
    const existing = readIfPresent(join5(repoDir, path));
    if (existing === null) return { path, state: "absent" };
    return { path, state: existing === content ? "current" : "differs" };
  });
}
function countStaleSkeleton(repoDir, team) {
  const files = classify(repoDir, upgradeCandidates(repoDir, team).files);
  return {
    absent: files.filter((file) => file.state === "absent").length,
    differs: files.filter((file) => file.state === "differs").length
  };
}

// src/lib/harvest.ts
var defaultHarvestConfig = {
  enabled: true,
  // Measured, not assumed: on an identical prompt from a real session, haiku
  // proposed the developer's stated rule 1 time in 3 and sonnet 3 in 3. That is one
  // prompt, three runs per model - too little to put a rate on, and all the evidence
  // this default rests on. The whole product is "every session teaches it something";
  // a default that stays silent two thirds of the time fails that. One call per
  // session, and {"harvest": {"model": "haiku"}} is still there for whoever wants it
  // cheaper.
  model: "sonnet",
  maxPerSession: 3,
  minScore: 4,
  transcriptCharCap: 4e4,
  // Latency is dominated by how much the model writes, not by the slice: a 31k-char
  // prompt returning nothing took 9s, a 6k one returning a full skill took 25s. Three
  // items is the cap, so ~75s is the realistic ceiling - and a timeout here does not
  // degrade to a smaller answer, it burns an attempt and can park the session in
  // abandoned.jsonl. This is the value the yield measurement was run at.
  timeoutMs: 18e4
};
function loadHarvestConfig(home = handbookHome()) {
  const harvest = readConfigFile(home).harvest;
  const num = (v, fallback) => typeof v === "number" && v > 0 ? v : fallback;
  return {
    // fail closed on a broken config - see configIsBroken
    enabled: !configIsBroken(home) && harvest?.enabled !== false,
    model: typeof harvest?.model === "string" ? harvest.model : defaultHarvestConfig.model,
    maxPerSession: num(harvest?.maxPerSession, defaultHarvestConfig.maxPerSession),
    minScore: typeof harvest?.minScore === "number" && harvest.minScore >= 0 && harvest.minScore <= 10 ? harvest.minScore : defaultHarvestConfig.minScore,
    transcriptCharCap: num(harvest?.transcriptCharCap, defaultHarvestConfig.transcriptCharCap),
    timeoutMs: num(harvest?.timeoutMs, defaultHarvestConfig.timeoutMs)
  };
}

// src/lib/status.ts
import { readFileSync as readFileSync5 } from "node:fs";
import { dirname as dirname3, join as join7 } from "node:path";
import { fileURLToPath } from "node:url";

// src/lib/notify.ts
var DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1e3;

// src/lib/pipeline.ts
import { basename, join as join6 } from "node:path";
var STALE_CLAIM_MS = 10 * 60 * 1e3;
function pipelineLogFile(home = handbookHome()) {
  return join6(home, "pipeline.log");
}
var LOG_ROTATE_BYTES = 512 * 1024;
var MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1e3;

// src/lib/status.ts
function pluginVersion() {
  const here = dirname3(fileURLToPath(import.meta.url));
  for (const up of ["..", "../.."]) {
    try {
      const parsed = JSON.parse(
        readFileSync5(join7(here, up, ".claude-plugin", "plugin.json"), "utf8")
      );
      if (typeof parsed?.version === "string") return parsed.version;
    } catch {
    }
  }
  return "unknown";
}
function lastPipelineRun(home = handbookHome()) {
  let raw;
  try {
    raw = readFileSync5(pipelineLogFile(home), "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (typeof parsed?.ts === "string") return parsed;
    } catch {
    }
  }
  return null;
}

// src/lib/doctor.ts
var runCommand = (cmd, args, timeoutMs) => execFileSync(cmd, args, {
  encoding: "utf8",
  timeout: timeoutMs,
  stdio: ["ignore", "pipe", "pipe"],
  // never let git/ssh block on an interactive prompt; stdin is closed anyway
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" }
}).trim();
function ok(name, detail) {
  return { name, level: "ok", detail };
}
function warn(name, detail) {
  return { name, level: "warn", detail };
}
function fail(name, detail) {
  return { name, level: "fail", detail };
}
function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 18 ? ok("node", `${process.version} (\u2265 18 required)`) : fail("node", `${process.version} - TeamHandbook needs Node \u2265 18`);
}
var PROBE_TIMEOUT_MS = 6e4;
function checkClaudeCli(run, home) {
  try {
    run("claude", ["--version"], 15e3);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return fail(
        "claude CLI",
        "not found on PATH - the gate and distiller need it; install Claude Code CLI or fix PATH"
      );
    }
    const message = String(err instanceof Error ? err.message : err).split("\n")[0];
    return fail("claude CLI", `found, but \`claude --version\` failed or timed out: ${message}`);
  }
  const harvestModel = loadHarvestConfig(home).model;
  const gateModel = loadScoreConfig(home).model;
  const distillModel = loadDistillConfig(home).model;
  const models = [...new Set([harvestModel, gateModel, distillModel].filter(Boolean))];
  for (const model of models) {
    try {
      const reply = run("claude", ["-p", "Reply with exactly: OK", ...model ? ["--model", model] : []], PROBE_TIMEOUT_MS);
      if (!/\bok\b/i.test(reply)) {
        return warn("claude CLI", `installed, but a probe with model "${model}" returned an unexpected reply: ${reply.slice(0, 60)}`);
      }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      const lower = message.toLowerCase();
      if (lower.includes("login") || lower.includes("auth") || lower.includes("logged")) {
        return fail("claude CLI", "installed but NOT logged in - run `claude` and /login; the gate cannot score until then");
      }
      if (err?.code === "ETIMEDOUT" || lower.includes("etimedout")) {
        return warn(
          "claude CLI",
          `installed and logged in, but the probe with model "${model}" did not answer within ${PROBE_TIMEOUT_MS / 1e3}s - usually a cold start; re-run this check`
        );
      }
      return fail(
        "claude CLI",
        `logged in, but \`claude -p --model ${model}\` failed - is that model valid? (config.json harvest.model/gate.model/distill.model): ${(message.split("\n")[0] ?? "").slice(0, 80)}`
      );
    }
  }
  return ok(
    "claude CLI",
    models.length > 1 ? `installed and authenticated (${models.length} configured models reachable)` : "installed and authenticated"
  );
}
function checkGitIdentity(home, run) {
  if (!loadTeamConfig(home)) return null;
  try {
    const email = run("git", ["config", "user.email"], 5e3);
    return email ? ok("git identity", `user.email = ${email}`) : fail("git identity", "git user.email is empty - team PRs would ship with a junk author; run `git config --global user.email you@example.com`");
  } catch {
    return fail("git identity", "git user.email is not set - team PRs would ship with a junk author; run `git config --global user.email you@example.com`");
  }
}
function checkHomeWritable(home) {
  const probe = join8(home, `.doctor-probe-${process.pid}`);
  try {
    mkdirSync4(home, { recursive: true });
    writeFileSync3(probe, "ok");
    rmSync3(probe, { force: true });
    return ok("state dir", `${displayPath(home)} writable`);
  } catch (err) {
    return fail("state dir", `cannot write ${displayPath(home)}: ${String(err instanceof Error ? err.message : err)}`);
  }
}
function checkConfig(home) {
  const file = join8(home, "config.json");
  if (!existsSync3(file)) return ok("config", "no config.json (defaults apply)");
  try {
    const parsed = JSON.parse(readFileSync6(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return fail(
        "config",
        "config.json is not a JSON object - automatic harvesting is OFF until it is (the privacy switches fail closed); every other setting falls back to its default"
      );
    }
    return ok("config", "config.json valid");
  } catch {
    return fail(
      "config",
      "config.json is not valid JSON - automatic harvesting is OFF until it parses (the privacy switches fail closed); every other setting falls back to its default"
    );
  }
}
function checkHooks(home) {
  const counters = readCounters(home);
  if (counters.postToolUse === 0) {
    return warn(
      "hooks",
      "no hook events recorded yet - run any command in a Claude Code session and re-check; if this stays 0 the hooks are not firing (was the plugin installed and the session restarted?)"
    );
  }
  return ok(
    "hooks",
    `firing - ${counters.postToolUse} tool calls seen, ${counters.bashFailuresCaptured} failures captured, ${counters.pairsResolved} pairs resolved`
  );
}
function remoteDistributionState(team, run) {
  const dir = handbookWorkdir("handbook-doctor-");
  try {
    run("git", ["clone", "--depth", "1", "--single-branch", "--", team.repoUrl, dir], 25e3);
    const version = JSON.parse(readFileSync6(join8(dir, ".claude-plugin", "plugin.json"), "utf8")).version;
    let skillCount = 0;
    try {
      skillCount = readdirSync3(join8(dir, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    } catch {
    }
    const behind = countStaleSkeleton(dir, team);
    return typeof version === "string" ? { version, skillCount, missing: behind.absent } : null;
  } catch {
    return null;
  } finally {
    rmSync3(dir, { recursive: true, force: true });
  }
}
function checkTeamRepo(home, run) {
  const team = loadTeamConfig(home);
  if (!team) return ok("team repo", "not configured (solo mode - that's fine)");
  try {
    run("git", ["ls-remote", "--heads", "--", team.repoUrl], 2e4);
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).split("\n").slice(-2).join(" | ");
    return fail("team repo", `${team.repoUrl} NOT reachable - approvals cannot publish (${message})`);
  }
  const dist = remoteDistributionState(team, run);
  if (dist && dist.skillCount > 0 && dist.version === "0.1.0") {
    return warn(
      "team repo",
      `${team.repoUrl} reachable, but ${dist.skillCount} merged skill(s) sit at plugin version 0.1.0 - the version-bump CI has not run, so teammates are NOT receiving updates (check the TEAMHANDBOOK_CI_TOKEN variable / Actions write permission)`
    );
  }
  if (dist && dist.missing > 0) {
    return warn(
      "team repo",
      `${team.repoUrl} reachable, but ${dist.missing} scaffold file(s) this version ships are not in it at all - run \`/handbook:init --upgrade\` to see what they are and pick which to add (your skills, commands and MCP settings are never touched)`
    );
  }
  return ok("team repo", `${team.repoUrl} reachable`);
}
function checkForge(home, run) {
  const team = loadTeamConfig(home);
  if (!team) return null;
  const tool = (hostFromUrl(team.repoUrl) ?? "").includes("github") ? "gh" : "glab";
  try {
    run(tool, ["auth", "status"], 1e4);
    return ok("forge CLI", `${tool} authenticated - approvals can auto-open PRs`);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return warn(
        "forge CLI",
        `${tool} not installed - approvals still push a branch and print a manual PR link; install ${tool} to auto-open PRs`
      );
    }
    return warn(
      "forge CLI",
      `${tool} installed but not authenticated - run \`${tool} auth login\` (approvals still print a manual link)`
    );
  }
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function declaredMcpServerNames(mcpFile) {
  let raw;
  try {
    raw = readFileSync6(mcpFile, "utf8");
  } catch {
    return { error: "unreadable" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "invalid-json" };
  }
  if (!isPlainObject(parsed)) return { error: "invalid-json" };
  const map = isPlainObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
  return { names: Object.keys(map) };
}
var MCP_LIST_LINE = /^(.+?):\s.*[-–]\s*(✔|✘|!)\s*(.+)$/;
function parseMcpListing(output) {
  const byName = /* @__PURE__ */ new Map();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = MCP_LIST_LINE.exec(line);
    if (!match) continue;
    const [, name, mark, detail] = match;
    const state = mark === "\u2714" ? "connected" : mark === "!" ? "needs-auth" : "failed";
    byName.set(name.trim(), { state, detail: detail.trim() });
  }
  return byName;
}
function checkTeamMcpServers(home, run, marketRoot = marketplacesRoot()) {
  const team = loadTeamConfig(home);
  if (!team) return null;
  const mcpFile = join8(marketRoot, team.marketplaceName, ".mcp.json");
  if (!existsSync3(mcpFile)) {
    return ok("team MCP servers", "the team has not shared an MCP server yet");
  }
  const declared = declaredMcpServerNames(mcpFile);
  if ("error" in declared) {
    return declared.error === "unreadable" ? warn("team MCP servers", `cannot read ${displayPath(mcpFile)} - connection state unknown`) : warn("team MCP servers", `${displayPath(mcpFile)} is not valid JSON - cannot verify connection state`);
  }
  if (declared.names.length === 0) {
    return ok("team MCP servers", "the team's .mcp.json declares no servers yet");
  }
  let listing;
  try {
    listing = run("claude", ["mcp", "list"], 2e4);
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).split("\n")[0];
    return warn("team MCP servers", `\`claude mcp list\` failed - connection state unknown: ${message}`);
  }
  const statuses = parseMcpListing(listing);
  if (statuses.size === 0) {
    return warn(
      "team MCP servers",
      "`claude mcp list` returned nothing this check recognizes - connection state unknown (never assumed connected)"
    );
  }
  const results = declared.names.map((name) => {
    const status = statuses.get(`plugin:${team.marketplaceName}:${name}`);
    if (!status) return { name, state: "unknown", detail: "not listed by `claude mcp list`" };
    return { name, state: status.state, detail: status.detail };
  });
  const summary = results.map((r) => `${r.name}: ${r.state === "connected" ? "connected" : r.detail}`).join("; ");
  if (results.some((r) => r.state === "failed")) {
    return fail("team MCP servers", summary);
  }
  if (results.some((r) => r.state === "unknown")) {
    return warn("team MCP servers", `connection state unknown for at least one server - ${summary}`);
  }
  if (results.some((r) => r.state === "needs-auth")) {
    return warn("team MCP servers", summary);
  }
  return ok("team MCP servers", summary);
}
function checkLastRun(home) {
  const last = lastPipelineRun(home);
  if (!last) return ok("gate pipeline", "no runs yet (nothing recurred or was captured manually)");
  if (last.errored > 0) {
    const reason = last.outcomes?.filter((o) => o.outcome === "error").at(-1)?.error;
    const why = reason ? ` - ${reason}` : "";
    return warn(
      "gate pipeline",
      `last run had ${last.errored} error(s)${why} (see the claude CLI check above; full log: ${displayPath(join8(home, "pipeline.log"))})`
    );
  }
  return ok("gate pipeline", `last run ${last.ts}: ${last.written.length} written, ${last.rejected} rejected`);
}
function checkAbandoned(home) {
  const abandoned = readCounters(home).gateAbandoned;
  if (abandoned === 0) return null;
  return warn(
    "abandoned pairs",
    `${abandoned} captured pair(s) were given up after repeated gate failures - recoverable in ${displayPath(join8(home, "abandoned.jsonl"))} once claude works again`
  );
}
function runDoctor(home = handbookHome(), run = runCommand, marketRoot = marketplacesRoot()) {
  const checks = [
    checkNode(),
    checkClaudeCli(run, home),
    checkHomeWritable(home),
    checkConfig(home),
    checkHooks(home),
    checkTeamRepo(home, run)
  ];
  const identity = checkGitIdentity(home, run);
  if (identity) checks.push(identity);
  const forge = checkForge(home, run);
  if (forge) checks.push(forge);
  const mcpServers = checkTeamMcpServers(home, run, marketRoot);
  if (mcpServers) checks.push(mcpServers);
  checks.push(checkLastRun(home));
  const abandoned = checkAbandoned(home);
  if (abandoned) checks.push(abandoned);
  return { version: pluginVersion(), checks };
}
var MARKS = { ok: "\u2714", warn: "\u26A0", fail: "\u2718" };
function formatDoctor(report2) {
  const lines = [`TeamHandbook doctor  (v${report2.version})`, ""];
  for (const check of report2.checks) {
    lines.push(` ${MARKS[check.level]} ${check.name}: ${check.detail}`);
  }
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const check of report2.checks) counts[check.level] += 1;
  lines.push("", `${counts.ok} ok, ${counts.warn} warning(s), ${counts.fail} problem(s)`);
  if (counts.fail === 0 && counts.warn === 0) lines.push("Everything looks healthy.");
  return lines.join("\n");
}
function doctorExitCode(report2) {
  return report2.checks.some((c) => c.level === "fail") ? 1 : 0;
}

// src/cli/doctor.ts
var report = runDoctor();
console.log(formatDoctor(report));
process.exitCode = doctorExitCode(report);
