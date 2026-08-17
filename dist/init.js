// src/lib/init.ts
import { execFileSync as execFileSync3 } from "node:child_process";
import { existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";

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
import { existsSync, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
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
    return "Install the GitHub CLI and sign in once: `brew install gh` then `gh auth login`. Run both in your own terminal, not here \u2014 the login is interactive.";
  }
  if (!creds.ghAuthenticated) {
    return "The GitHub CLI is installed but not signed in. Run `gh auth login` in your own terminal \u2014 the login is interactive, so it cannot happen from inside a session.";
  }
  return "The GitHub CLI is signed in, so the account it is signed in as is probably not the one with access. Check with `gh auth status`, and ask whoever set the handbook up to add that account.";
}
function cloneFailureReason(url, err, creds = probeCredentials()) {
  const raw = String(err instanceof Error ? err.message : err);
  const text = raw.toLowerCase();
  const detail = raw.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "";
  if (text.includes("could not read username") || text.includes("terminal prompts disabled") || text.includes("authentication failed")) {
    return `cannot sign in to ${url} \u2014 this machine has no git credentials for it. A team handbook is normally a private repo, so this is the usual first step, not a fault. ` + credentialAdvice(url, creds) + " You also need to have been given access to the repository itself; the two are separate.";
  }
  if (text.includes("permission denied (publickey)") || text.includes("host key verification")) {
    return `SSH refused by ${url} \u2014 the key this machine offers is not registered on that host, or no key is loaded. Add your public key to the forge account, or use the HTTPS URL with credentials.`;
  }
  if (text.includes("repository not found") || text.includes("not found") || text.includes("does not exist")) {
    return `${url} is not there, or your account cannot see it. A private repo answers exactly the same way as a typo, so check the URL first, then whether you have been given access.`;
  }
  if (text.includes("could not resolve host") || text.includes("network") || text.includes("timed out")) {
    return `cannot reach ${url} from this machine (network or DNS): ${detail}`;
  }
  return `git clone failed for ${url}: ${detail}`;
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
      `${join3(home, "config.json")} exists but is not valid JSON. TeamHandbook will not rewrite it, because doing so would silently discard settings you wrote \u2014 including the privacy switches, which are currently failing closed. Fix the JSON (or delete the file) and try again.`
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
    # only run when the CI token exists \u2014 otherwise skip (don't fail the pipeline)
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

Your team's skill base: approved skills distilled by TeamHandbook from real coding
sessions (error\u2192fix moments and task procedures). This repository is a Claude Code
plugin marketplace; every merge reaches all subscribed teammates automatically.

## Access

If this repository is private, each teammate needs two separate things: access to the
repository (ask whoever set it up), and git credentials on their own machine. The second
is a one-time interactive sign-in they run themselves, for example
\`brew install gh && gh auth login\` for GitHub over HTTPS, or an SSH key registered with
the forge. Without it the commands below fail with a bare git error, because a plugin
can never stop to ask for a password.

## Consume skills (no TeamHandbook needed)

\`\`\`
/plugin marketplace add ${url}
/plugin install ${name}@${name}
\`\`\`

## Produce skills (TeamHandbook engine required)

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
job that bumps the version on merge instead; \`scripts/bump-version.mjs\` is what it
runs, and it is left in place either way.

This plugin ships a tiny dependency-free SessionStart hook that shows consumers a
"N new skills" notice; it records the skill names it has already shown you under
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
// Prints "<plugin>: N new skills since your last session" \u2014 no dependencies, no
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
  const seenDir = join(homedir(), ".teamhandbook-consumer");
  const seenFile = join(seenDir, name + ".json");
  let prior = null;
  try { prior = JSON.parse(readFileSync(seenFile, "utf8")); } catch {}
  mkdirSync(seenDir, { recursive: true });
  writeFileSync(seenFile, JSON.stringify(current));
  if (Array.isArray(prior)) {
    const fresh = current.filter((s) => !prior.includes(s));
    if (fresh.length) console.log(name + ": " + fresh.length + " new skill(s) since your last session: " + fresh.join(", ") + ".");
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
            description: "Approved team skills distilled from real coding sessions by TeamHandbook."
          }
        ]
      },
      null,
      2
    ) + "\n",
    ".claude-plugin/plugin.json": JSON.stringify(
      {
        name,
        description: "Approved team skills distilled from real coding sessions by TeamHandbook.",
        version: "0.1.0"
      },
      null,
      2
    ) + "\n",
    "README.md": readmeFor(name, url),
    "scripts/bump-version.mjs": BUMP_SCRIPT,
    "skills/README.md": "Approved skills land here, one directory per skill (SKILL.md + grounded-case.json).\n"
  };
  if (withCi) {
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
      const tail = stderr.trim().split("\n").slice(-3).join(" | ");
      throw new Error(`git ${args[0]} failed: ${tail}`);
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
function pushFailureReason(url, branch, err) {
  const raw = String(err instanceof Error ? err.message : err);
  const text = raw.toLowerCase();
  const detail = raw.split("\n").find((l) => l.trim())?.slice(0, 140) ?? "";
  const remoteSaid = raw.split("\n").filter((l) => l.trim().startsWith("remote:")).map((l) => l.replace(/^\s*remote:\s*/, "").trim()).filter(Boolean);
  const pattern = raw.match(/does not follow the pattern\s*'([^']+)'/)?.[1];
  if (pattern && !/commit message/i.test(raw)) {
    return `${url} rejected the branch NAME "${branch}": this project requires branch names matching ${pattern}. Nothing is wrong with your access. Re-run with a prefix that fits, for example --branch-prefix "HEM-1-", and it is remembered for every skill shared later.`;
  }
  if (text.includes("protected") || text.includes("not allowed to push")) {
    return `${url} refused the push to ${branch}: ${remoteSaid[0] ?? "that branch is protected"}. Ask for the role that lets you write there, or have someone who has it push once.`;
  }
  if (/commit message/i.test(raw) && /pattern|does not|must/i.test(raw)) {
    return `${url} rejected the commit MESSAGE, not the contents: ${remoteSaid[0] ?? detail} Re-run with a prefix that satisfies it, for example --commit-prefix "HEM-1", and it is remembered for every skill shared later.`;
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
      error: `a team repository is already configured; run /handbook:leave (or edit ${join3(home, "config.json")}) to re-init`
    };
  }
  const identity = gitIdentityArgs(git);
  if (!identity) {
    return {
      ok: false,
      error: 'git user.name/user.email is not set \u2014 the scaffold commit would have an author your forge is likely to reject. Run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`, then re-run.'
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
      error: `${url} is already a handbook \u2014 run /handbook:join ${url} to point this machine at it instead of scaffolding it again`
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
      "Scaffolds this repository as a Claude Code marketplace so approved skills can be distributed from it: marketplace manifest, plugin manifest, the version-bump CI, and a `skills/` directory.\n\nOpened by TeamHandbook.",
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
    ...result.merged ? [`  pushed:      marketplace skeleton + version-bump CI, straight to ${result.branch} (the repo was empty)`] : [
      `  pushed:      marketplace skeleton + version-bump CI to branch ${result.branch}`,
      result.prUrl ? `  request:     ${result.prUrl}` : `  request:     open it here \u2014 ${result.manualUrl ?? `push ${result.branch} and open a request against ${result.defaultBranch}`}`,
      ...result.prError ? [`               (could not open it automatically: ${result.prError})`] : [],
      `  NOT LIVE until that is merged into ${result.defaultBranch}. Share the message below after it is.`
    ],
    // Silence is the wrong signal here: a team whose README already said something
    // keeps it, and then the join instructions live nowhere unless they are told.
    ...result.skipped?.length ? [
      `  left alone: ${result.skipped.join(", ")} (already had content)`,
      "               the handbook README explains how teammates join \u2014 if yours was kept,",
      "               copy that section across from skills/README.md or this output."
    ] : [],
    `  config:      team repo saved to ${join3(result.home ?? "", "config.json")}`,
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

// src/cli/init.ts
function usage() {
  console.error("usage: init.js <git-url> [--name <marketplace-name>] [--branch-prefix <prefix>] [--commit-prefix <prefix>] [--with-ci]");
  process.exit(2);
}
function main() {
  const args = process.argv.slice(2);
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
