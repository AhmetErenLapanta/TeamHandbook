// src/lib/init.ts
import { execFileSync } from "node:child_process";
import { mkdirSync as mkdirSync2, mkdtempSync, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2, tmpdir } from "node:os";
import { dirname as dirname2, join as join3 } from "node:path";

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";

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
var SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var SESSION_ORPHAN_MS = 3 * 60 * 60 * 1e3;

// src/lib/config.ts
import { existsSync, readFileSync } from "node:fs";
import { join as join2 } from "node:path";
function configFile(home = handbookHome()) {
  return join2(home, "config.json");
}
function readConfigFile(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync(configFile(home), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function configIsBroken(home = handbookHome()) {
  const file = configFile(home);
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
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

// src/lib/init.ts
var REMOTE_HELPER = /^[A-Za-z][A-Za-z0-9+.-]*::/;
function assertSafeGitUrl(url) {
  const u = url.trim();
  if (!u || u.startsWith("-") || REMOTE_HELPER.test(u) || /[\r\n\0]/.test(u)) {
    throw new Error(`unsafe or unsupported git URL: ${url}`);
  }
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
function hostFromUrl(url) {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return null;
  return normalized.slice(0, normalized.indexOf("/"));
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
var GITHUB_WORKFLOW = `name: version-bump

# Bumps the plugin version on every merge to main. The version string is Claude Code's
# update signal: without a bump, teammates keep serving the cached marketplace copy.
on:
  push:
    branches: [main]

jobs:
  bump:
    if: "!startsWith(github.event.head_commit.message, 'ci: bump plugin version')"
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
          git commit -am "ci: bump plugin version"
          git push
`;
var GITLAB_CI = `# Bumps the plugin version on every merge to the default branch. The version string is
# Claude Code's update signal: without a bump, teammates keep serving the cached copy.
# Requires a project access token with write_repository scope stored in the
# TEAMHANDBOOK_CI_TOKEN CI/CD variable (Settings > CI/CD > Variables).
version-bump:
  image: node:20
  rules:
    # only run when the CI token exists \u2014 otherwise skip (don't fail the pipeline)
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_COMMIT_MESSAGE !~ /^ci: bump plugin version/ && $TEAMHANDBOOK_CI_TOKEN'
  script:
    - node scripts/bump-version.mjs
    - git config user.name "handbook-ci"
    - git config user.email "handbook-ci@noreply.invalid"
    - git commit -am "ci: bump plugin version"
    - git push "https://oauth2:\${TEAMHANDBOOK_CI_TOKEN}@\${CI_SERVER_HOST}/\${CI_PROJECT_PATH}.git" "HEAD:\${CI_DEFAULT_BRANCH}"
`;
function readmeFor(name, url) {
  const ciSetup = (hostFromUrl(url) ?? "").includes("github") ? "the repository's Actions must have **Read and write permissions** (Settings \u2192 Actions \u2192 General), and if the default branch is protected, Actions must be allowed to push to it." : "a project access token with `write_repository` scope must be stored in the **TEAMHANDBOOK_CI_TOKEN** CI/CD variable (Settings \u2192 CI/CD \u2192 Variables); until it is set the bump job is skipped and no teammate's copy refreshes.";
  return `# ${name}

Your team's skill base: approved skills distilled by TeamHandbook from real coding
sessions (error\u2192fix moments and task procedures). This repository is a Claude Code
plugin marketplace; every merge reaches all subscribed teammates automatically.

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

Every merge to the default branch bumps the plugin version via CI
(\`scripts/bump-version.mjs\`), which triggers Claude Code's background marketplace
update on each teammate's machine. Skills live under \`skills/\`, one directory per
skill (\`SKILL.md\` plus the \`grounded-case.json\` evidence it was distilled from).

> **CI setup (required for the above to work):** ${ciSetup} With it unset, merges do
> not bump the version and teammates silently stop receiving updates.

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
function skeletonFiles(name, url, host) {
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
  if (host && host.includes("github")) {
    files[".github/workflows/version-bump.yml"] = GITHUB_WORKFLOW;
  } else {
    files[".gitlab-ci.yml"] = GITLAB_CI;
  }
  return files;
}
function writeSkeleton(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join3(dir, path);
    mkdirSync2(dirname2(target), { recursive: true });
    writeFileSync2(target, content);
  }
}
function runGit(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch (err) {
    const stderr = err?.stderr;
    if (typeof stderr === "string" && stderr.trim()) {
      const tail = stderr.trim().split("\n").slice(-3).join(" | ");
      throw new Error(`git ${args[0]} failed: ${tail}`);
    }
    throw err;
  }
}
function initTeamRepo(url, name, home = handbookHome(), git = runGit, now = (/* @__PURE__ */ new Date()).toISOString()) {
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
  const workdir = mkdtempSync(join3(tmpdir(), "handbook-init-"));
  writeSkeleton(workdir, skeletonFiles(marketplaceName, url, hostFromUrl(url)));
  try {
    git(["init", "-b", "main"], workdir);
    git(["add", "-A"], workdir);
    git(
      ["-c", "user.name=TeamHandbook", "-c", "user.email=TeamHandbook@localhost", "commit", "-m", "chore: scaffold team skill base"],
      workdir
    );
    git(["remote", "add", "origin", "--", url], workdir);
    git(["push", "-u", "origin", "main"], workdir);
  } catch (err) {
    return { ok: false, error: `git failed (is the target repo empty and reachable?): ${String(err)}` };
  }
  saveTeamConfig({ repoUrl: url, marketplaceName, initializedAt: now }, home);
  return { ok: true, name: marketplaceName, url, home };
}
function formatInitSuccess(result) {
  const isGitHub = !!result.url && (hostFromUrl(result.url) ?? "").includes("github");
  const ciNote = isGitHub ? [
    "",
    "  \u26A0 CI: the version-bump workflow needs write access. In the repo settings enable",
    "    'Read and write permissions' for Actions (Settings \u2192 Actions \u2192 General).",
    "    If the default branch is protected, also allow Actions to bypass the push",
    "    restriction (branch-protection rule) or push with a PAT secret \u2014 otherwise the",
    "    bump push is rejected on every merge and teammates stop updating."
  ] : [
    "",
    "  \u26A0 CI (required for auto-distribution): the version-bump job needs a project access",
    "    token with the `write_repository` scope, a Maintainer role, and permission to push",
    "    to the protected default branch. Add it as a CI/CD variable named TEAMHANDBOOK_CI_TOKEN",
    "    (Settings \u2192 CI/CD \u2192 Variables). Until it's set the job is SKIPPED and teammates'",
    "    marketplace copies won't refresh \u2014 nothing else will warn you."
  ];
  return [
    "Team skill base initialized.",
    "",
    `  repository:  ${result.url}`,
    `  marketplace: ${result.name}`,
    "  pushed:      marketplace skeleton + version-bump CI (branch main)",
    `  config:      team repo saved to ${join3(result.home ?? "", "config.json")}`,
    ...ciNote,
    "",
    "Tell your teammates who will PRODUCE skills to run:",
    "",
    `  /handbook:join ${result.url}`,
    "",
    "Teammates who only want to CONSUME skills need two built-in commands instead:",
    "",
    `  /plugin marketplace add ${result.url}`,
    `  /plugin install ${result.name}@${result.name}`
  ].join("\n");
}

// src/cli/init.ts
function usage() {
  console.error("usage: init.js <git-url> [--name <marketplace-name>]");
  process.exit(2);
}
function main() {
  const args = process.argv.slice(2);
  let url;
  let name;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name") {
      name = args[++i];
      if (!name) usage();
    } else if (!url) {
      url = args[i];
    } else {
      usage();
    }
  }
  if (!url) usage();
  const result = initTeamRepo(url, name);
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(formatInitSuccess(result));
}
main();
