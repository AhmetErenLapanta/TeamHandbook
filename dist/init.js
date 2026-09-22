// src/lib/config.ts
import { existsSync, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/lib/session-state.ts
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync as mkdirSync2, mkdtempSync, readFileSync, readdirSync, rmSync as rmSync2, statSync } from "node:fs";

// src/lib/fs-atomic.ts
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var seq = 0;
function writeFileAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${seq++}-${process.hrtime.bigint().toString(36)}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// src/lib/session-state.ts
var EDIT_ATTACH_WINDOW_MS = 15 * 60 * 1e3;
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}
function handbookWorkdir(prefix, home = handbookHome()) {
  try {
    const root = join(home, "tmp");
    mkdirSync2(root, { recursive: true });
    return mkdtempSync(join(root, prefix));
  } catch {
    return mkdtempSync(join(tmpdir(), prefix));
  }
}
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var SESSION_ORPHAN_MS = 3 * 60 * 60 * 1e3;

// src/lib/config.ts
function configFile(home = handbookHome()) {
  return join2(home, "config.json");
}
function readConfigFile(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync2(configFile(home), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function configIsBroken(home = handbookHome()) {
  const file = configFile(home);
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync2(file, "utf8"));
    return !(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  } catch {
    return true;
  }
}

// src/lib/init.ts
import { execFileSync as execFileSync3 } from "node:child_process";
import { existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";

// src/lib/score.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);

// src/lib/distill.ts
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
function slugifySkillName(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
  return slug || null;
}
function uniqueSlug(baseSlug, taken) {
  let slug = baseSlug;
  for (let i = 2; taken(slug); i++) slug = `${baseSlug}-${i}`;
  return slug;
}

// src/lib/forge.ts
import { execFileSync } from "node:child_process";
function hostFromUrl(url) {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return null;
  return normalized.slice(0, normalized.indexOf("/"));
}
var FORGE_TIMEOUT_MS = 6e4;
function runForge(tool, args, cwd) {
  return execFileSync(tool, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: nonInteractiveEnv(),
    timeout: FORGE_TIMEOUT_MS
  });
}
function manualPrUrl(repoUrl, branch) {
  const normalized = normalizeRemoteUrl(repoUrl);
  if (!normalized) return null;
  const host = hostFromUrl(repoUrl);
  if (host && host.includes("github")) {
    return `https://${normalized}/pull/new/${branch}`;
  }
  return `https://${normalized}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
}
function extractUrl(output) {
  return output.match(/https?:\/\/\S+/)?.[0] ?? null;
}
function openPr(repoUrl, branch, title, body, repoDir, forge) {
  const host = hostFromUrl(repoUrl);
  try {
    const out = host && host.includes("github") ? forge("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body], repoDir) : forge(
      "glab",
      ["mr", "create", "--source-branch", branch, "--title", title, "--description", body, "--yes"],
      repoDir
    );
    return { url: extractUrl(out) };
  } catch (err) {
    const e = err;
    const tool = host && host.includes("github") ? "gh" : "glab";
    let reason;
    if (e?.code === "ENOENT") reason = `the ${tool} CLI is not installed`;
    else {
      const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
      reason = (stderr ? stderr.split("\n").at(-1) : String(e?.message ?? err)).slice(0, 160);
    }
    return { url: null, error: reason };
  }
}

// src/lib/git-errors.ts
import { execFileSync as execFileSync2 } from "node:child_process";
function probeCredentials() {
  const run = (cmd, args) => execFileSync2(cmd, args, { encoding: "utf8", timeout: 5e3, stdio: ["ignore", "pipe", "pipe"] });
  try {
    run("gh", ["--version"]);
  } catch {
    return { ghInstalled: false, ghAuthenticated: false };
  }
  try {
    run("gh", ["auth", "status"]);
    return { ghInstalled: true, ghAuthenticated: true };
  } catch {
    return { ghInstalled: true, ghAuthenticated: false };
  }
}
function credentialAdvice(url, creds) {
  if (!url.startsWith("http")) {
    return "This is an SSH URL, so it needs a key this forge recognises: `ssh-keygen -t ed25519`, then add ~/.ssh/id_ed25519.pub to your account's SSH keys.";
  }
  if (!creds.ghInstalled) {
    return "Install the GitHub CLI and sign in once: `brew install gh` then `gh auth login`. Run both in your own terminal, not here - the login is interactive.";
  }
  if (!creds.ghAuthenticated) {
    return "The GitHub CLI is installed but not signed in. Run `gh auth login` in your own terminal - the login is interactive, so it cannot happen from inside a session.";
  }
  return "The GitHub CLI is signed in, so the account it is signed in as is probably not the one with access. Check with `gh auth status`, and ask whoever set the handbook up to add that account.";
}
function cloneFailureReason(url, err, creds = probeCredentials()) {
  const raw = String(err instanceof Error ? err.message : err);
  const text = raw.toLowerCase();
  const detail = raw.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "";
  if (text.includes("could not read username") || text.includes("terminal prompts disabled") || text.includes("authentication failed")) {
    return `cannot sign in to ${url} - this machine has no git credentials for it. A team handbook is normally a private repo, so this is the usual first step, not a fault. ` + credentialAdvice(url, creds) + " You also need to have been given access to the repository itself; the two are separate.";
  }
  if (text.includes("permission denied (publickey)") || text.includes("host key verification")) {
    return `SSH refused by ${url} - the key this machine offers is not registered on that host, or no key is loaded. Add your public key to the forge account, or use the HTTPS URL with credentials.`;
  }
  if (text.includes("repository not found") || text.includes("not found") || text.includes("does not exist")) {
    return `${url} is not there, or your account cannot see it. A private repo answers exactly the same way as a typo, so check the URL first, then whether you have been given access.`;
  }
  if (text.includes("could not resolve host") || text.includes("network") || text.includes("timed out")) {
    return `cannot reach ${url} from this machine (network or DNS): ${detail}`;
  }
  return `git clone failed for ${url}: ${detail}`;
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
var REMOTE_HELPER = /^[A-Za-z][A-Za-z0-9+.-]*::/;
function assertSafeGitUrl(url) {
  const u = url.trim();
  if (!u || u.startsWith("-") || REMOTE_HELPER.test(u) || /[\r\n\0]/.test(u)) {
    throw new Error(`unsafe or unsupported git URL: ${url}`);
  }
}
var DEFAULT_BRANCH_PREFIX = "handbook/";
function teamCommitPrefix(config) {
  return config?.commitPrefix?.trim() ? `${config.commitPrefix.trim()} ` : "";
}
function teamBranchPrefix(config) {
  return config?.branchPrefix?.trim() || DEFAULT_BRANCH_PREFIX;
}
function loadTeamConfig(home = handbookHome()) {
  const team = readConfigFile(home).team;
  if (team && typeof team.repoUrl === "string" && typeof team.marketplaceName === "string") {
    return team;
  }
  return null;
}
var BrokenConfigError = class extends Error {
  constructor(home) {
    super(
      `${displayPath(join3(home, "config.json"))} exists but is not valid JSON. TeamHandbook will not rewrite it, because doing so would silently discard settings you wrote - including the privacy switches, which are currently failing closed. Fix the JSON (or delete the file) and try again.`
    );
    this.name = "BrokenConfigError";
  }
};
function saveTeamConfig(team, home = handbookHome()) {
  if (configIsBroken(home)) throw new BrokenConfigError(home);
  const config = readConfigFile(home);
  config.team = team;
  writeFileAtomic(join3(home, "config.json"), JSON.stringify(config, null, 2) + "\n");
}
function repoNameFromUrl(url) {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return null;
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return name || null;
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
function writeSkeletonPreserving(dir, files) {
  const written = [];
  const skipped = [];
  for (const [path, content] of Object.entries(files)) {
    const target = join3(dir, path);
    let existing = "";
    try {
      existing = readFileSync3(target, "utf8");
    } catch {
    }
    if (existing.trim()) {
      skipped.push(path);
      continue;
    }
    mkdirSync3(dirname2(target), { recursive: true });
    writeFileSync2(target, content);
    written.push(path);
  }
  return { written, skipped };
}
function nonInteractiveEnv(base = process.env) {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GLAB_NO_PROMPT: "1",
    GH_PROMPT_DISABLED: "1",
    NO_COLOR: "1"
  };
}
var GIT_TIMEOUT_MS = 12e4;
function summarizeGitStderr(stderr, tailLines = 3) {
  const lines = stderr.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
  const explanations = lines.filter((line) => line.trim().startsWith("remote:"));
  const tail = lines.slice(-tailLines).filter((line) => !explanations.includes(line));
  return [...explanations, ...tail].join("\n");
}
function runGit(args, cwd) {
  try {
    return execFileSync3("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: nonInteractiveEnv(),
      timeout: GIT_TIMEOUT_MS
    });
  } catch (err) {
    const stderr = err?.stderr;
    if (typeof stderr === "string" && stderr.trim()) {
      throw new Error(`git ${args[0]} failed: ${summarizeGitStderr(stderr)}`);
    }
    throw err;
  }
}
function gitIdentityArgs(git) {
  const read = (key) => {
    try {
      return String(git(["config", key], process.cwd()) ?? "").trim();
    } catch {
      return "";
    }
  };
  const name = read("user.name");
  const email = read("user.email");
  if (!name || !email) return null;
  return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
}
var INIT_BRANCH_PREFIX_FIX = 'Re-run with a prefix that fits, for example --branch-prefix "TEAM-1-", and it is remembered for every skill shared later.';
function pushFailureReason(url, branch, err, branchPrefixFix = INIT_BRANCH_PREFIX_FIX) {
  const raw = String(err instanceof Error ? err.message : err);
  const text = raw.toLowerCase();
  const detail = raw.split("\n").find((l) => l.trim())?.slice(0, 140) ?? "";
  const remoteSaid = raw.split("\n").filter((l) => l.trim().startsWith("remote:")).map((l) => l.replace(/^\s*remote:\s*/, "").trim()).filter(Boolean);
  const pattern = raw.match(/does not follow the pattern\s*'([^']+)'/)?.[1];
  if (pattern && !/commit message/i.test(raw)) {
    return `${url} rejected the branch NAME "${branch}": this project requires branch names matching ${pattern}. Nothing is wrong with your access. ${branchPrefixFix}`;
  }
  if (text.includes("protected") || text.includes("not allowed to push")) {
    return `${url} refused the push to ${branch}: ${remoteSaid[0] ?? "that branch is protected"}. Ask for the role that lets you write there, or have someone who has it push once.`;
  }
  if (/commit message/i.test(raw) && /pattern|does not|must/i.test(raw)) {
    return `${url} rejected the commit MESSAGE, not the contents: ${remoteSaid[0] ?? detail} Re-run with a prefix that satisfies it, for example --commit-prefix "TEAM-1", and it is remembered for every skill shared later.`;
  }
  if (/author|committer/i.test(raw) && /email|not a .* user|restricted/i.test(raw)) {
    return `${url} rejected the commit AUTHOR: ${remoteSaid[0] ?? detail} The commit is made with your own \`git config user.name/user.email\`, so set those to the address your forge knows you by.`;
  }
  if (text.includes("pre-receive hook declined")) {
    return `${url} refused the push to ${branch} through a server-side rule: ${remoteSaid.join(" ") || detail}`;
  }
  if (text.includes("non-fast-forward") || text.includes("fetch first") || text.includes("rejected")) {
    return `${url} moved while this ran; nothing was changed. Re-run /handbook:init and it will pick the new state up.`;
  }
  return `pushing the scaffold to ${branch} on ${url} failed: ${detail}`;
}
function initTeamRepo(url, name, home = handbookHome(), git = runGit, now = (/* @__PURE__ */ new Date()).toISOString(), forge = runForge, branchPrefix = DEFAULT_BRANCH_PREFIX, commitPrefix = "", withCi = false) {
  if (!url.trim()) return { ok: false, error: "a git URL is required" };
  try {
    assertSafeGitUrl(url);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  const marketplaceName = slugifySkillName(name ?? repoNameFromUrl(url) ?? "");
  if (!marketplaceName) {
    return { ok: false, error: `cannot derive a marketplace name from "${url}"; pass --name` };
  }
  if (configIsBroken(home)) {
    return { ok: false, error: new BrokenConfigError(home).message };
  }
  if (loadTeamConfig(home)) {
    return {
      ok: false,
      // Leaving used to be the only thing this could say, and it is the wrong advice for
      // the common reason someone arrives here: their scaffold is behind the version they
      // just installed. Leaving and re-initializing means a SECOND repository, which is a
      // loss dressed as a fix, so the refresh is named first and leaving keeps its real
      // job - pointing this machine at a different team.
      error: `a team repository is already configured. To bring its scaffold up to this version, run \`/handbook:init --upgrade\` - it shows what would change and writes nothing until you pick. To point at a DIFFERENT team, run /handbook:leave (or edit ${displayPath(join3(home, "config.json"))}) first.`
    };
  }
  const identity = gitIdentityArgs(git);
  if (!identity) {
    return {
      ok: false,
      error: 'git user.name/user.email is not set - the scaffold commit would have an author your forge is likely to reject. Run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`, then re-run.'
    };
  }
  const workdir = handbookWorkdir("handbook-init-");
  const repoDir = join3(workdir, "repo");
  try {
    git(["clone", "--", url, repoDir], workdir);
  } catch (err) {
    return { ok: false, error: cloneFailureReason(url, err) };
  }
  let branch;
  try {
    branch = String(git(["symbolic-ref", "--short", "HEAD"], repoDir) ?? "").trim();
  } catch {
    branch = "";
  }
  if (!branch) {
    return { ok: false, error: `cannot tell which branch ${url} uses by default; push a first commit to it and re-run` };
  }
  let isEmptyRepo;
  try {
    isEmptyRepo = !String(git(["rev-parse", "--verify", "HEAD"], repoDir) ?? "").trim();
  } catch {
    isEmptyRepo = true;
  }
  if (existsSync2(join3(repoDir, ".claude-plugin", "marketplace.json"))) {
    return {
      ok: false,
      error: `${url} is already a handbook - run /handbook:join ${url} to point this machine at it instead of scaffolding it again`
    };
  }
  const { skipped } = writeSkeletonPreserving(
    repoDir,
    skeletonFiles(marketplaceName, url, hostFromUrl(url), commitPrefix, withCi)
  );
  const scaffoldBranch = `${branchPrefix}scaffold`;
  const direct = isEmptyRepo;
  try {
    if (!direct) git(["checkout", "-b", scaffoldBranch], repoDir);
    git(["add", "-A"], repoDir);
    git([...identity, "commit", "-m", `${commitPrefix}chore: scaffold team skill base`], repoDir);
    git(["push", "origin", direct ? `HEAD:${branch}` : `HEAD:${scaffoldBranch}`], repoDir);
  } catch (err) {
    return { ok: false, error: pushFailureReason(url, direct ? branch : scaffoldBranch, err) };
  }
  let prUrl = null;
  let prError;
  if (!direct) {
    const opened = openPr(
      url,
      scaffoldBranch,
      "chore: set up the team handbook",
      `Scaffolds this repository as a Claude Code marketplace so approved skills can be distributed from it: marketplace manifest, plugin manifest${withCi ? ", the version-bump CI," : ","} and a \`skills/\` directory.

Opened by TeamHandbook.`,
      repoDir,
      forge
    );
    prUrl = opened.url;
    prError = opened.error;
  }
  saveTeamConfig(
    {
      repoUrl: url,
      marketplaceName,
      initializedAt: now,
      ...branchPrefix !== DEFAULT_BRANCH_PREFIX ? { branchPrefix } : {},
      ...commitPrefix ? { commitPrefix: commitPrefix.trim() } : {}
    },
    home
  );
  return {
    ok: true,
    name: marketplaceName,
    url,
    home,
    branch: direct ? branch : scaffoldBranch,
    defaultBranch: branch,
    merged: direct,
    skipped,
    withCi,
    ...prUrl ? { prUrl } : {},
    ...prError ? { prError } : {},
    ...!direct && !prUrl ? { manualUrl: manualPrUrl(url, scaffoldBranch) ?? void 0 } : {}
  };
}
function formatInitSuccess(result) {
  const isGitHub = !!result.url && (hostFromUrl(result.url) ?? "").includes("github");
  return [
    "Team skill base initialized.",
    "",
    `  repository:  ${result.url}`,
    `  marketplace: ${result.name}`,
    ...result.merged ? [
      `  pushed:      marketplace skeleton${result.withCi ? " + version-bump CI" : ""}, straight to ${result.branch} (the repo was empty)`
    ] : [
      `  pushed:      marketplace skeleton${result.withCi ? " + version-bump CI" : ""} to branch ${result.branch}`,
      result.prUrl ? `  request:     ${result.prUrl}` : `  request:     open it here - ${result.manualUrl ?? `push ${result.branch} and open a request against ${result.defaultBranch}`}`,
      ...result.prError ? [`               (could not open it automatically: ${result.prError})`] : [],
      `  NOT LIVE until that is merged into ${result.defaultBranch}. Share the message below after it is.`
    ],
    // Silence is the wrong signal here: a team whose README already said something
    // keeps it, and then the join instructions live nowhere unless they are told.
    ...result.skipped?.length ? [
      `  left alone: ${result.skipped.join(", ")} (already had content)`,
      "               the handbook README explains how teammates join - if yours was kept,",
      "               copy that section across from skills/README.md or this output."
    ] : [],
    `  config:      team repo saved to ${displayPath(join3(result.home ?? "", "config.json"))}`,
    "",
    // A handbook is normally private, and a private repo needs two separate things
    // from each teammate: access to the repo, and credentials on their machine. The
    // first person to try this had neither, had never used GitHub, and met a raw git
    // error. Nothing here had told the champion there was anything to arrange.
    "BEFORE you share this, give each teammate access to the repository. If it is",
    "private they also need git credentials on their own machine, which is a one-time",
    "interactive login they have to run themselves. Send them this:",
    "",
    "  ---------------------------------------------------------------",
    `  Our team handbook lives at ${result.url} and I have given you access.`,
    "",
    "  If you have never pushed to this host from this machine, sign in once,",
    "  in your own terminal (it opens a browser):",
    "",
    isGitHub ? "    brew install gh && gh auth login        # GitHub over HTTPS" : "    brew install glab && glab auth login    # GitLab over HTTPS,",
    ...isGitHub ? [] : ["                                            # or add an SSH key to your account"],
    "",
    "  Then, in Claude Code:",
    "",
    "  To USE the team's skills:",
    `    /plugin marketplace add ${result.url}`,
    `    /plugin install ${result.name}@${result.name}`,
    "",
    "  To also CONTRIBUTE your own:",
    `    /handbook:join ${result.url}`,
    "  ---------------------------------------------------------------",
    "",
    "A public handbook needs none of the sign-in step: anyone can clone it. Private is",
    "the right default for team knowledge, so the login is the price of that choice."
  ].join("\n");
}

// src/lib/upgrade.ts
import { existsSync as existsSync4, lstatSync, mkdirSync as mkdirSync5, readFileSync as readFileSync5, rmSync as rmSync4, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname as dirname3, join as join5, relative } from "node:path";

// src/lib/publish.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync4, readdirSync as readdirSync2, readFileSync as readFileSync4, rmSync as rmSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join4 } from "node:path";
function bumpPluginVersion(repoDir) {
  const file = join4(repoDir, ".claude-plugin", "plugin.json");
  try {
    const plugin = JSON.parse(readFileSync4(file, "utf8"));
    const parts = String(plugin.version ?? "0.1.0").split(".").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    parts[2] = (parts[2] ?? 0) + 1;
    plugin.version = parts.join(".");
    writeFileSync3(file, JSON.stringify(plugin, null, 2) + "\n");
    return plugin.version;
  } catch {
    return null;
  }
}

// src/lib/upgrade.ts
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
    return readFileSync5(file, "utf8");
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
  const withCi = existsSync4(join5(repoDir, CI_MARKER));
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
function refreshable(files) {
  return files.filter((file) => file.state !== "current").map((file) => file.path);
}
function unreadableManifests(repoDir, candidates) {
  const explained = new Set([...candidates.linked, ...candidates.withheld].map((file) => file.path));
  return [PLUGIN_MANIFEST, MARKETPLACE_MANIFEST].filter(
    (path) => !(path in candidates.files) && !explained.has(path) && readIfPresent(join5(repoDir, path)) !== null
  );
}
function versionPlan(repoDir) {
  const raw = readIfPresent(join5(repoDir, PLUGIN_MANIFEST));
  const manifest = raw === null ? null : parseObject(raw);
  const current = manifest && typeof manifest.version === "string" ? manifest.version : void 0;
  if (!current) {
    return {
      blocked: `${PLUGIN_MANIFEST} in this repository declares no version this can read, so the refresh cannot raise one and no teammate's copy will pick it up. Refreshing that file itself puts a version there, and every refresh after it raises that.`
    };
  }
  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return {
      current,
      blocked: `the plugin version "${current}" is not a three-part MAJOR.MINOR.PATCH number, so it cannot be raised - and without a raise, no teammate's copy refreshes for this. Set a three-part version in ${PLUGIN_MANIFEST} by hand first.`
    };
  }
  return { current, next: [parts[0], parts[1], (parts[2] ?? 0) + 1].join(".") };
}
function cloneForUpgrade(git, team, repoDir, workdir) {
  try {
    git(["clone", "--depth", "1", "--", team.repoUrl, repoDir], workdir);
  } catch (err) {
    return `git clone failed (is ${team.repoUrl} reachable?): ${String(err instanceof Error ? err.message : err)}`;
  }
  if (!existsSync4(join5(repoDir, MARKETPLACE_MANIFEST))) {
    return `${team.repoUrl} carries no ${MARKETPLACE_MANIFEST}, so it is not a handbook this can refresh. Check the repository in your config, or run /handbook:init against a repository that should become one.`;
  }
  return null;
}
function writeCandidates(repoDir, candidates, paths) {
  for (const path of paths) {
    const link = symlinkOnPath(repoDir, path);
    if (link) {
      return `"${path}" cannot be written: the repository carries a symbolic link at "${link}", and following it would write outside the repository. Nothing was changed.`;
    }
  }
  for (const path of paths) {
    const target = join5(repoDir, path);
    mkdirSync5(dirname3(target), { recursive: true });
    writeFileSync4(target, candidates[path]);
  }
  return null;
}
function stage(git, repoDir, paths) {
  git(["add", "-A"], repoDir);
  const staged = new Set(
    String(git(["diff", "--cached", "--name-only"], repoDir) ?? "").split("\n").map((line) => line.trim()).filter(Boolean)
  );
  return { missing: paths.filter((path) => !staged.has(path)) };
}
function ignoredPathsMessage(missing) {
  return `${missing.join(", ")} cannot be committed to this repository - git refused to stage it, which a \`.gitignore\` rule in the team repo is what normally does. Nothing was changed. Take that path out of the repository's .gitignore, or leave it out of the refresh.`;
}
function trackedModes(git, repoDir) {
  const modes = /* @__PURE__ */ new Map();
  try {
    for (const line of String(git(["ls-files", "--stage"], repoDir) ?? "").split("\n")) {
      const match = line.match(/^(\d{6}) [0-9a-f]+ \d\t(.*)$/);
      if (match) modes.set(match[2], match[1]);
    }
  } catch {
  }
  return modes;
}
function checkIgnore(git, repoDir, paths) {
  try {
    return String(git(["check-ignore", "--", ...paths], repoDir) ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
function planUpgrade(team, git = runGit) {
  try {
    assertSafeGitUrl(team.repoUrl);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  const workdir = handbookWorkdir("handbook-upgrade-");
  const repoDir = join5(workdir, "repo");
  const scratch = join5(workdir, "candidate");
  try {
    const cloneError = cloneForUpgrade(git, team, repoDir, workdir);
    if (cloneError) return { ok: false, error: cloneError };
    const candidates = upgradeCandidates(repoDir, team);
    const files = classify(repoDir, candidates.files);
    const paths = refreshable(files);
    const unreadable = unreadableManifests(repoDir, candidates);
    const plan = {
      ok: true,
      url: team.repoUrl,
      files,
      withCi: existsSync4(join5(repoDir, CI_MARKER)),
      version: versionPlan(repoDir),
      ...candidates.linked.length ? { linked: candidates.linked } : {},
      ...candidates.withheld.length ? { withheld: candidates.withheld } : {},
      ...unreadable.length ? { unreadable } : {}
    };
    if (!paths.length) return plan;
    try {
      const ignored = checkIgnore(git, repoDir, paths);
      if (ignored.length) plan.ignored = ignored;
      const modes = trackedModes(git, repoDir);
      const cacheinfo = [];
      for (const path of paths) {
        const file = join5(scratch, path);
        mkdirSync5(dirname3(file), { recursive: true });
        writeFileSync4(file, candidates.files[path]);
        const sha = String(git(["hash-object", "-w", "--", file], repoDir) ?? "").trim();
        cacheinfo.push("--cacheinfo", `${modes.get(path) ?? "100644"},${sha},${path}`);
      }
      git(["update-index", "--add", ...cacheinfo], repoDir);
      plan.stat = String(git(["diff", "--cached", "--stat"], repoDir) ?? "").trimEnd();
      plan.diff = String(git(["diff", "--cached"], repoDir) ?? "");
    } catch {
    }
    return plan;
  } finally {
    rmSync4(workdir, { recursive: true, force: true });
  }
}
function remoteBranches(git, repoDir) {
  try {
    return new Set(
      String(git(["ls-remote", "--heads", "origin"], repoDir) ?? "").split("\n").map((line) => line.split("	")[1] ?? "").filter(Boolean).map((ref) => ref.replace("refs/heads/", ""))
    );
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function applyUpgrade(team, paths, git = runGit, forge = runForge) {
  if (!paths.length) {
    return { ok: false, error: "no file was named, so nothing was refreshed and nothing was pushed" };
  }
  try {
    assertSafeGitUrl(team.repoUrl);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  const identity = gitIdentityArgs(git);
  if (!identity) {
    return {
      ok: false,
      error: 'git user.name/user.email is not set - the refresh commit would have an author your forge is likely to reject. Run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`, then try again.'
    };
  }
  const workdir = handbookWorkdir("handbook-upgrade-");
  const repoDir = join5(workdir, "repo");
  try {
    const cloneError = cloneForUpgrade(git, team, repoDir, workdir);
    if (cloneError) return { ok: false, error: cloneError };
    const candidates = upgradeCandidates(repoDir, team);
    const states = new Map(classify(repoDir, candidates.files).map((file) => [file.path, file.state]));
    for (const path of paths) {
      const withheld = [...candidates.linked, ...candidates.withheld].find((file) => file.path === path);
      if (withheld) return { ok: false, error: `"${path}" is not offered here: ${withheld.reason}` };
      if (!(path in candidates.files)) {
        return {
          ok: false,
          error: `"${path}" is not a scaffold file this can refresh. Run the plan again and copy a path from it; the team's own skills, commands and MCP settings are never touched.`
        };
      }
      if (states.get(path) === "current") {
        return { ok: false, error: `"${path}" already matches this version, so nothing was changed.` };
      }
    }
    const version = versionPlan(repoDir);
    const prefix = teamBranchPrefix(team);
    const taken = remoteBranches(git, repoDir);
    const branch = `${prefix}${uniqueSlug("refresh-scaffold", (slug) => taken.has(`${prefix}${slug}`))}`;
    const title = "chore: refresh the team handbook scaffold";
    let raised = null;
    try {
      git(["checkout", "-b", branch], repoDir);
      const writeError = writeCandidates(repoDir, candidates.files, paths);
      if (writeError) return { ok: false, error: writeError };
      if (version.next) raised = bumpPluginVersion(repoDir);
      const { missing } = stage(git, repoDir, paths);
      if (missing.length) return { ok: false, error: ignoredPathsMessage(missing) };
      git([...identity, "commit", "-m", `${teamCommitPrefix(team)}${title}`], repoDir);
      git(["push", "-u", "origin", branch], repoDir);
    } catch (err) {
      return {
        ok: false,
        error: pushFailureReason(
          team.repoUrl,
          branch,
          err,
          'Set "branchPrefix" under "team" in your TeamHandbook config.json to a prefix that fits (for example "TEAM-1-"), then run this again.'
        )
      };
    }
    const pr = openPr(
      team.repoUrl,
      branch,
      title,
      [
        "Refreshes the scaffold files this repository received from `/handbook:init` to the version",
        "TeamHandbook ships today. Nothing under `skills/`, `commands/`, `agents/` or `.mcp.json` is",
        "touched; in the two manifests the team's own entries are carried across, and the plugin",
        "version is raised rather than reset, so teammates' copies pick this up.",
        "",
        "Files in this request:",
        ...paths.map((path) => `- \`${path}\``),
        "",
        "Opened by TeamHandbook."
      ].join("\n"),
      repoDir,
      forge
    );
    return {
      ok: true,
      url: team.repoUrl,
      refreshed: paths,
      branch,
      ...raised ? { version: raised } : {},
      ...raised ? {} : version.blocked ? { versionNotRaised: version.blocked } : {},
      ...pr.url ? { prUrl: pr.url } : { manualUrl: manualPrUrl(team.repoUrl, branch) ?? void 0 },
      ...pr.url ? {} : pr.error ? { prError: pr.error } : {}
    };
  } finally {
    rmSync4(workdir, { recursive: true, force: true });
  }
}
function withheldLines(files) {
  return files.flatMap((file) => [`  ${"NOT OFFERED".padEnd(16)} ${file.path}`, `                   ${file.reason}`]);
}
function formatUpgradePlan(plan) {
  const files = plan.files ?? [];
  const paths = refreshable(files);
  const lines = [`Team handbook scaffold at ${plan.url}`, ""];
  for (const file of files) {
    const label = file.state === "current" ? "up to date" : file.state === "absent" ? "NOT IN THE REPO" : "DIFFERS";
    lines.push(`  ${label.padEnd(16)} ${file.path}`);
  }
  lines.push(...withheldLines(plan.linked ?? []), ...withheldLines(plan.withheld ?? []));
  for (const path of plan.unreadable ?? []) {
    lines.push(
      `  ${"SKIPPED".padEnd(16)} ${path}`,
      "                   it is not valid JSON, so what the team put in it could not be read and",
      "                   carried across. Fix the JSON by hand and run this again."
    );
  }
  if (!paths.length) {
    lines.push("", "Nothing to refresh - every scaffold file already matches this version.");
    return lines.join("\n");
  }
  lines.push(
    "",
    `${paths.length} file(s) can be refreshed. A DIFFERS file may be an old scaffold or an edit your team`,
    "made on purpose - nothing records which, so read the diff before choosing it.",
    "",
    "The team's own content is never part of this: skills/, commands/, agents/ and .mcp.json are",
    "not offered and cannot be written, and inside the two manifests the team's own entries - the",
    "plugin version, any extra plugins, the marketplace owner - are carried across, not replaced."
  );
  const version = plan.version ?? {};
  if (version.next) {
    lines.push(
      "",
      `The merge request also raises the plugin version, ${version.current} -> ${version.next}, the way every share does.`,
      "Without that, no teammate's copy refreshes for this."
    );
  } else if (version.blocked) {
    lines.push("", `WARNING: ${version.blocked}`);
  }
  if (plan.ignored?.length) {
    lines.push("", `WARNING: ${ignoredPathsMessage(plan.ignored)}`, "The diff below does not show it.");
  }
  if (plan.stat) lines.push("", plan.stat);
  if (plan.diff) lines.push("", plan.diff.trimEnd());
  lines.push(
    "",
    "Nothing has been changed, in this repository or on this machine. To send a refresh, name",
    "each file you want:",
    "",
    `  ${paths.map((path) => `--file ${path}`).join(" ")}`
  );
  return lines.join("\n");
}
function formatUpgradeResult(result) {
  return [
    "Scaffold refresh opened.",
    "",
    `  repository:  ${result.url}`,
    `  refreshed:   ${result.refreshed?.join(", ")}`,
    `  branch:      ${result.branch}`,
    ...result.version ? [`  version:     raised to ${result.version}`] : [],
    ...result.versionNotRaised ? [`  version:     NOT raised. ${result.versionNotRaised}`] : [],
    result.prUrl ? `  request:     ${result.prUrl}` : `  request:     open it here - ${result.manualUrl ?? `push ${result.branch} and open a request against the default branch`}`,
    ...result.prError ? [`               (could not open it automatically: ${result.prError})`] : [],
    "",
    "Nothing reaches anyone until that is merged."
  ].join("\n");
}

// src/cli/init.ts
function usage() {
  console.error(
    "usage: init.js <git-url> [--name <marketplace-name>] [--branch-prefix <prefix>] [--commit-prefix <prefix>] [--with-ci]\n       init.js --upgrade [--file <scaffold-path>]..."
  );
  process.exit(2);
}
function upgrade(args) {
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--upgrade") continue;
    if (args[i] !== "--file") usage();
    const value = args[++i];
    if (!value || value.startsWith("--")) usage();
    files.push(value);
  }
  if (configIsBroken()) {
    console.error(
      "error: TeamHandbook's config.json is not valid JSON, so it cannot tell which repository your team uses. Fix the JSON (or delete the file) and try again."
    );
    process.exit(1);
  }
  const team = loadTeamConfig();
  if (!team) {
    console.error(
      "error: no team repository is configured, so there is no scaffold to refresh. Run /handbook:init <url> to create one, or /handbook:join <url> to point at your team's."
    );
    process.exit(1);
  }
  if (!files.length) {
    const plan = planUpgrade(team);
    if (!plan.ok) {
      console.error(`error: ${plan.error}`);
      process.exit(1);
    }
    console.log(formatUpgradePlan(plan));
    return;
  }
  const result = applyUpgrade(team, files);
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(formatUpgradeResult(result));
}
function main() {
  const args = process.argv.slice(2);
  if (args.includes("--upgrade")) return upgrade(args);
  let url;
  let name;
  let branchPrefix;
  let commitPrefix;
  let withCi = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name") {
      name = args[++i];
      if (!name) usage();
    } else if (args[i] === "--branch-prefix") {
      branchPrefix = args[++i];
      if (!branchPrefix) usage();
    } else if (args[i] === "--commit-prefix") {
      commitPrefix = args[++i];
      if (!commitPrefix) usage();
    } else if (args[i] === "--with-ci") {
      withCi = true;
    } else if (!url) {
      url = args[i];
    } else {
      usage();
    }
  }
  if (!url) usage();
  const result = initTeamRepo(url, name, void 0, void 0, void 0, void 0, branchPrefix, commitPrefix, withCi);
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(formatInitSuccess(result));
}
main();
