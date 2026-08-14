import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeRemoteUrl, slugifySkillName } from "./distill.js";
import { handbookWorkdir,handbookHome } from "./session-state.js";
import { configIsBroken, readConfigFile } from "./config.js";
import { writeFileAtomic } from "./fs-atomic.js";

// git's remote-helper syntax (`ext::sh -c ...`, `fd::`, generally `<transport>::`)
// runs arbitrary commands on clone, and a URL starting with `-` is parsed as an
// option (`--upload-pack=...`). Everything else — https/ssh/git@ URLs, file://,
// and plain local paths — is safe. Denylist those two forms rather than allowlist
// transports, so legitimate local-path repos still work.
const REMOTE_HELPER = /^[A-Za-z][A-Za-z0-9+.-]*::/;

export function assertSafeGitUrl(url: string): void {
  const u = url.trim();
  if (!u || u.startsWith("-") || REMOTE_HELPER.test(u) || /[\r\n\0]/.test(u)) {
    throw new Error(`unsafe or unsupported git URL: ${url}`);
  }
}

export interface TeamConfig {
  repoUrl: string;
  marketplaceName: string;
  initializedAt?: string;
  joinedAt?: string;
}

export function loadTeamConfig(home: string = handbookHome()): TeamConfig | null {
  const team = readConfigFile(home).team as TeamConfig | undefined;
  if (team && typeof team.repoUrl === "string" && typeof team.marketplaceName === "string") {
    return team;
  }
  return null;
}

export class BrokenConfigError extends Error {
  constructor(home: string) {
    super(
      `${join(home, "config.json")} exists but is not valid JSON. TeamHandbook will not ` +
        "rewrite it, because doing so would silently discard settings you wrote — " +
        "including the privacy switches, which are currently failing closed. Fix the " +
        "JSON (or delete the file) and try again.",
    );
    this.name = "BrokenConfigError";
  }
}

/** Read-modify-write of config.json. REFUSES on a broken file: readConfigFile
 * collapses one to {}, so writing would erase whatever the user actually had —
 * exactly the `{"harvest":{"enabled":false}}` opt-out that made it broken-looking. */
export function saveTeamConfig(team: TeamConfig, home: string = handbookHome()): void {
  if (configIsBroken(home)) throw new BrokenConfigError(home);
  const config = readConfigFile(home);
  config.team = team;
  writeFileAtomic(join(home, "config.json"), JSON.stringify(config, null, 2) + "\n");
}

/** Drop the team binding (the escape hatch for a wrong URL or a team switch),
 * leaving every other config key intact. Returns the repo that was left, if any. */
export function clearTeamConfig(home: string = handbookHome()): string | null {
  if (configIsBroken(home)) throw new BrokenConfigError(home);
  const config = readConfigFile(home);
  const previous = (config.team as TeamConfig | undefined)?.repoUrl ?? null;
  if (!("team" in config)) return null;
  delete config.team;
  writeFileAtomic(join(home, "config.json"), JSON.stringify(config, null, 2) + "\n");
  return previous;
}

export function hostFromUrl(url: string): string | null {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return null;
  return normalized.slice(0, normalized.indexOf("/"));
}

export function repoNameFromUrl(url: string): string | null {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return null;
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return name || null;
}

const BUMP_SCRIPT = `import { readFileSync, writeFileSync } from "node:fs";

const file = ".claude-plugin/plugin.json";
const plugin = JSON.parse(readFileSync(file, "utf8"));
const parts = plugin.version.split(".").map(Number);
parts[2] += 1;
plugin.version = parts.join(".");
writeFileSync(file, JSON.stringify(plugin, null, 2) + "\\n");
console.log(\`bumped plugin version to \${plugin.version}\`);
`;

const GITHUB_WORKFLOW = `name: version-bump

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

const GITLAB_CI = `# Bumps the plugin version on every merge to the default branch. The version string is
# Claude Code's update signal: without a bump, teammates keep serving the cached copy.
# Requires a project access token with write_repository scope stored in the
# TEAMHANDBOOK_CI_TOKEN CI/CD variable (Settings > CI/CD > Variables).
version-bump:
  image: node:20
  rules:
    # only run when the CI token exists — otherwise skip (don't fail the pipeline)
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_COMMIT_MESSAGE !~ /^ci: bump plugin version/ && $TEAMHANDBOOK_CI_TOKEN'
  script:
    - node scripts/bump-version.mjs
    - git config user.name "handbook-ci"
    - git config user.email "handbook-ci@noreply.invalid"
    - git commit -am "ci: bump plugin version"
    - git push "https://oauth2:\${TEAMHANDBOOK_CI_TOKEN}@\${CI_SERVER_HOST}/\${CI_PROJECT_PATH}.git" "HEAD:\${CI_DEFAULT_BRANCH}"
`;

function readmeFor(name: string, url: string): string {
  const ciSetup = (hostFromUrl(url) ?? "").includes("github")
    ? "the repository's Actions must have **Read and write permissions** (Settings → Actions → " +
      "General), and if the default branch is protected, Actions must be allowed to push to it."
    : "a project access token with `write_repository` scope must be stored in the " +
      "**TEAMHANDBOOK_CI_TOKEN** CI/CD variable (Settings → CI/CD → Variables); until it is set the " +
      "bump job is skipped and no teammate's copy refreshes.";
  return `# ${name}

Your team's skill base: approved skills distilled by TeamHandbook from real coding
sessions (error→fix moments and task procedures). This repository is a Claude Code
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

// A tiny, dependency-free SessionStart hook that ships INSIDE the team plugin, so
// even consumers who never install TeamHandbook itself get "N new team skills" notices.
const CONSUMER_NOTICE_HOOKS = JSON.stringify(
  {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/notice.mjs"' }] },
      ],
    },
  },
  null,
  2,
);

const CONSUMER_NOTICE_SCRIPT = `#!/usr/bin/env node
// Prints "<plugin>: N new skills since your last session" — no dependencies, no
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

export function skeletonFiles(name: string, url: string, host: string | null): Record<string, string> {
  const files: Record<string, string> = {
    "hooks/hooks.json": CONSUMER_NOTICE_HOOKS + "\n",
    "hooks/notice.mjs": CONSUMER_NOTICE_SCRIPT,
    ".claude-plugin/marketplace.json":
      JSON.stringify(
        {
          name,
          owner: { name: `${name} maintainers` },
          plugins: [
            {
              name,
              source: "./",
              description: "Approved team skills distilled from real coding sessions by TeamHandbook.",
            },
          ],
        },
        null,
        2,
      ) + "\n",
    ".claude-plugin/plugin.json":
      JSON.stringify(
        {
          name,
          description: "Approved team skills distilled from real coding sessions by TeamHandbook.",
          version: "0.1.0",
        },
        null,
        2,
      ) + "\n",
    "README.md": readmeFor(name, url),
    "scripts/bump-version.mjs": BUMP_SCRIPT,
    "skills/README.md":
      "Approved skills land here, one directory per skill (SKILL.md + grounded-case.json).\n",
  };
  if (host && host.includes("github")) {
    files[".github/workflows/version-bump.yml"] = GITHUB_WORKFLOW;
  } else {
    files[".gitlab-ci.yml"] = GITLAB_CI;
  }
  return files;
}

export function writeSkeleton(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

export type GitRunner = (args: string[], cwd: string) => string | void;

/**
 * Nothing run on the user's behalf may stop to ask a question. These calls happen
 * from a slash command or a detached hook, where a prompt has no one to answer it —
 * git would wait on a username, glab on a confirmation, and the publish would hang
 * instead of failing. Every one of them fails with a reason instead.
 *
 * NO_COLOR is not cosmetic here: the PR URL is recovered from the tool's stdout with
 * a regex, and an ANSI escape wrapped around it would be captured as part of the URL.
 */
export function nonInteractiveEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GLAB_NO_PROMPT: "1",
    GH_PROMPT_DISABLED: "1",
    NO_COLOR: "1",
  };
}

export const GIT_TIMEOUT_MS = 120_000;

export function runGit(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: nonInteractiveEnv(),
      timeout: GIT_TIMEOUT_MS,
    });
  } catch (err) {
    // Surface git's actual reason (e.g. "Permission denied (publickey)") instead
    // of the bare "Command failed: git …" — the difference between a five-second
    // and a half-hour diagnosis for the user.
    const stderr = (err as { stderr?: unknown })?.stderr;
    if (typeof stderr === "string" && stderr.trim()) {
      const tail = stderr.trim().split("\n").slice(-3).join(" | ");
      throw new Error(`git ${args[0]} failed: ${tail}`);
    }
    throw err;
  }
}

export function marketplacesRoot(): string {
  return join(homedir(), ".claude", "plugins", "marketplaces");
}

/**
 * Where merged team skills land on this machine once Claude Code has pulled the
 * team marketplace in the background, or null when no team repo is configured.
 * Used so the session-start "new team skills" notice and the gate's dedup can see
 * skills that arrived via the team repo, not just local ones.
 */
export function teamSkillsDir(
  home: string = handbookHome(),
  root: string = marketplacesRoot(),
): string | null {
  const team = loadTeamConfig(home);
  return team ? join(root, team.marketplaceName, "skills") : null;
}

export interface InitResult {
  ok: boolean;
  name?: string;
  url?: string;
  home?: string;
  error?: string;
}

export function initTeamRepo(
  url: string,
  name?: string,
  home: string = handbookHome(),
  git: GitRunner = runGit,
  now: string = new Date().toISOString(),
): InitResult {
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
      error: `a team repository is already configured; run /handbook:leave (or edit ${join(home, "config.json")}) to re-init`,
    };
  }
  const workdir = handbookWorkdir("handbook-init-");
  writeSkeleton(workdir, skeletonFiles(marketplaceName, url, hostFromUrl(url)));
  try {
    git(["init", "-b", "main"], workdir);
    git(["add", "-A"], workdir);
    git(
      ["-c", "user.name=TeamHandbook", "-c", "user.email=TeamHandbook@localhost", "commit", "-m", "chore: scaffold team skill base"],
      workdir,
    );
    git(["remote", "add", "origin", "--", url], workdir);
    git(["push", "-u", "origin", "main"], workdir);
  } catch (err) {
    return { ok: false, error: `git failed (is the target repo empty and reachable?): ${String(err)}` };
  }
  saveTeamConfig({ repoUrl: url, marketplaceName, initializedAt: now }, home);
  return { ok: true, name: marketplaceName, url, home };
}

export function formatInitSuccess(result: InitResult): string {
  const isGitHub = !!result.url && (hostFromUrl(result.url) ?? "").includes("github");
  const ciNote = isGitHub
    ? [
        "",
        "  ⚠ CI: the version-bump workflow needs write access. In the repo settings enable",
        "    'Read and write permissions' for Actions (Settings → Actions → General).",
        "    If the default branch is protected, also allow Actions to bypass the push",
        "    restriction (branch-protection rule) or push with a PAT secret — otherwise the",
        "    bump push is rejected on every merge and teammates stop updating.",
      ]
    : [
        "",
        "  ⚠ CI (required for auto-distribution): the version-bump job needs a project access",
        "    token with the `write_repository` scope, a Maintainer role, and permission to push",
        "    to the protected default branch. Add it as a CI/CD variable named TEAMHANDBOOK_CI_TOKEN",
        "    (Settings → CI/CD → Variables). Until it's set the job is SKIPPED and teammates'",
        "    marketplace copies won't refresh — nothing else will warn you.",
      ];
  return [
    "Team skill base initialized.",
    "",
    `  repository:  ${result.url}`,
    `  marketplace: ${result.name}`,
    "  pushed:      marketplace skeleton + version-bump CI (branch main)",
    `  config:      team repo saved to ${join(result.home ?? "", "config.json")}`,
    ...ciNote,
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
    "    brew install gh && gh auth login        # GitHub over HTTPS",
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
    "the right default for team knowledge, so the login is the price of that choice.",
  ].join("\n");
}
