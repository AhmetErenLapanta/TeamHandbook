import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeRemoteUrl, slugifySkillName } from "./distill.js";
export { hostFromUrl } from "./forge.js";
import { hostFromUrl, manualPrUrl, openPr, runForge } from "./forge.js";
import type { ForgeRunner } from "./forge.js";
import { handbookHome, handbookWorkdir } from "./session-state.js";
import { cloneFailureReason } from "./git-errors.js";
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
  // What every branch this tool pushes is named with. Default "handbook/", which reads
  // well and groups them — but organisations enforce branch naming rules, and one real
  // GitLab group rejected `handbook/scaffold` outright because branches there must look
  // like `HEM-42-something`. Every skill shared with the team would have been rejected
  // the same way, so this is not decoration.
  branchPrefix?: string;
  // Prepended to every commit message this tool writes, for the same reason as
  // branchPrefix: a group that polices branch names usually polices commit messages too.
  commitPrefix?: string;
}

export const DEFAULT_BRANCH_PREFIX = "handbook/";

export function teamCommitPrefix(config: TeamConfig | null): string {
  return config?.commitPrefix?.trim() ? `${config.commitPrefix.trim()} ` : "";
}

export function teamBranchPrefix(config: TeamConfig | null): string {
  return config?.branchPrefix?.trim() || DEFAULT_BRANCH_PREFIX;
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

const githubWorkflow = (bump: string) => `name: version-bump

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

const gitlabCi = (bump: string) => `# Bumps the plugin version on every merge to the default branch. The version string is
# Claude Code's update signal: without a bump, teammates keep serving the cached copy.
# Requires a project access token with write_repository scope stored in the
# TEAMHANDBOOK_CI_TOKEN CI/CD variable (Settings > CI/CD > Variables).
version-bump:
  image: node:20
  rules:
    # only run when the CI token exists — otherwise skip (don't fail the pipeline)
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_COMMIT_MESSAGE !~ /^${bump}/ && $TEAMHANDBOOK_CI_TOKEN'
  script:
    - node scripts/bump-version.mjs
    - git config user.name "handbook-ci"
    - git config user.email "handbook-ci@noreply.invalid"
    - git commit -am "${bump}"
    - git push "https://oauth2:\${TEAMHANDBOOK_CI_TOKEN}@\${CI_SERVER_HOST}/\${CI_PROJECT_PATH}.git" "HEAD:\${CI_DEFAULT_BRANCH}"
`;

function readmeFor(name: string, url: string): string {
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

Every skill arrives as a merge request that also raises the version in
\`.claude-plugin/plugin.json\`. That version is Claude Code's signal that the plugin
moved: merge the request and each teammate's marketplace copy refreshes on its own.
Skills live under \`skills/\`, one directory per skill (\`SKILL.md\` plus the
\`grounded-case.json\` evidence it was distilled from).

Nothing here needs CI, an access token, or the right to push to a protected branch. If
skills also arrive by hand in this repository, \`/handbook:init --with-ci\` scaffolds a
job that bumps the version on merge instead, together with the script it runs.

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

export function skeletonFiles(name: string, url: string, host: string | null, commitPrefix = "", withCi = false): Record<string, string> {
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
    "skills/README.md":
      "Approved skills land here, one directory per skill (SKILL.md + grounded-case.json).\n",
  };
  // Opt-in only. The version bump now travels inside the merge request that carries the
  // skill, so the ordinary path needs no CI, no access token, and no permission to push
  // to a protected default branch — three things that had to be right before anyone
  // received anything, with nothing to warn you when they were not. The job stays
  // available for repositories where skills also arrive by hand, and it faces the same
  // commit-message rules the developer does.
  if (withCi) {
    // The script only exists to be run by that job. Shipping it without the job put a
    // file in every team's repository that nothing on earth would ever execute.
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

export function writeSkeleton(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/**
 * Lay the skeleton into a repository that may already have things in it, and report
 * what was left alone. A file that already carries content is never overwritten: a
 * team's README is theirs, and a handbook is not worth losing it over. An empty file
 * is not content — forges create a placeholder README on project creation, and
 * refusing to fill that in would be pedantry.
 */
export function writeSkeletonPreserving(
  dir: string,
  files: Record<string, string>,
): { written: string[]; skipped: string[] } {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    let existing = "";
    try {
      existing = readFileSync(target, "utf8");
    } catch {
      // absent, which is the common case
    }
    if (existing.trim()) {
      skipped.push(path);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    written.push(path);
  }
  return { written, skipped };
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

/** A push that is refused says why, and on a forge the reason is nearly always a rule
 * somebody set rather than a broken command. */
/** The developer's own git identity as `-c` args, or null when they have none set.
 * Every commit this tool makes is theirs, because a forge that checks authors will
 * refuse anything else, and because the history should say who actually did it. */
export function gitIdentityArgs(git: GitRunner): string[] | null {
  const read = (key: string): string => {
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

export function pushFailureReason(url: string, branch: string, err: unknown): string {
  const raw = String(err instanceof Error ? err.message : err);
  const text = raw.toLowerCase();
  const detail = raw.split("\n").find((l) => l.trim())?.slice(0, 140) ?? "";
  // The forge usually explains itself on a `remote:` line; the classifier's job is to
  // not lose it. Reporting "protected branch, ask for Maintainer" against a GitLab group
  // that had simply banned the branch NAME sent one real user to ask for permissions
  // they already had.
  const remoteSaid = raw
    .split("\n")
    .filter((l) => l.trim().startsWith("remote:"))
    .map((l) => l.replace(/^\s*remote:\s*/, "").trim())
    .filter(Boolean);
  const pattern = raw.match(/does not follow the pattern\s*'([^']+)'/)?.[1];
  // both branch-name and commit-message rules phrase themselves the same way, so the
  // subject has to decide which knob to point at
  if (pattern && !/commit message/i.test(raw)) {
    return (
      `${url} rejected the branch NAME "${branch}": this project requires branch names ` +
      `matching ${pattern}. Nothing is wrong with your access. Re-run with a prefix that fits, ` +
      'for example --branch-prefix "HEM-1-", and it is remembered for every skill shared later.'
    );
  }
  if (text.includes("protected") || text.includes("not allowed to push")) {
    return (
      `${url} refused the push to ${branch}: ${remoteSaid[0] ?? "that branch is protected"}. ` +
      "Ask for the role that lets you write there, or have someone who has it push once."
    );
  }
  if (/commit message/i.test(raw) && /pattern|does not|must/i.test(raw)) {
    return (
      `${url} rejected the commit MESSAGE, not the contents: ${remoteSaid[0] ?? detail} ` +
      'Re-run with a prefix that satisfies it, for example --commit-prefix "HEM-1", and it is ' +
      "remembered for every skill shared later."
    );
  }
  if (/author|committer/i.test(raw) && /email|not a .* user|restricted/i.test(raw)) {
    return (
      `${url} rejected the commit AUTHOR: ${remoteSaid[0] ?? detail} The commit is made with ` +
      "your own `git config user.name/user.email`, so set those to the address your forge knows you by."
    );
  }
  if (text.includes("pre-receive hook declined")) {
    return (
      `${url} refused the push to ${branch} through a server-side rule: ` +
      `${remoteSaid.join(" ") || detail}`
    );
  }
  if (text.includes("non-fast-forward") || text.includes("fetch first") || text.includes("rejected")) {
    return `${url} moved while this ran; nothing was changed. Re-run /handbook:init and it will pick the new state up.`;
  }
  return `pushing the scaffold to ${branch} on ${url} failed: ${detail}`;
}

export interface InitResult {
  ok: boolean;
  name?: string;
  url?: string;
  home?: string;
  error?: string;
  // the branch the scaffold was pushed to: a scaffold branch, or the default branch
  // itself when the repository was empty and there was nothing to open a request against
  branch?: string;
  // the repository's own default branch, which the request targets
  defaultBranch?: string;
  // true when the scaffold is already on the default branch (empty repo), false when it
  // is waiting in a merge request
  merged?: boolean;
  prUrl?: string;
  manualUrl?: string;
  prError?: string;
  // files the repository already had, left untouched
  skipped?: string[];
}

export function initTeamRepo(
  url: string,
  name?: string,
  home: string = handbookHome(),
  git: GitRunner = runGit,
  now: string = new Date().toISOString(),
  forge: ForgeRunner = runForge,
  branchPrefix: string = DEFAULT_BRANCH_PREFIX,
  commitPrefix = "",
  withCi = false,
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
  const identity = gitIdentityArgs(git);
  if (!identity) {
    return {
      ok: false,
      error:
        "git user.name/user.email is not set — the scaffold commit would have an author " +
        "your forge is likely to reject. Run `git config --global user.name \"Your Name\"` " +
        "and `git config --global user.email you@example.com`, then re-run.",
    };
  }
  const workdir = handbookWorkdir("handbook-init-");
  const repoDir = join(workdir, "repo");
  // Clone first, always. Building a fresh history locally and pushing it assumed the
  // remote was empty, and most teams create the repository through their organisation's
  // tooling, which leaves a README in it. It also assumed the branch was called main,
  // while plenty of organisations still default to master — and a scaffold pushed to
  // the wrong branch is a handbook whose version-bump CI never runs.
  try {
    git(["clone", "--", url, repoDir], workdir);
  } catch (err) {
    return { ok: false, error: cloneFailureReason(url, err) };
  }
  let branch: string;
  try {
    branch = String(git(["symbolic-ref", "--short", "HEAD"], repoDir) ?? "").trim();
  } catch {
    branch = "";
  }
  if (!branch) {
    return { ok: false, error: `cannot tell which branch ${url} uses by default; push a first commit to it and re-run` };
  }
  // No commits yet means no branch to open a request against; that is the only case
  // where the scaffold has to land on the default branch directly.
  let isEmptyRepo: boolean;
  try {
    isEmptyRepo = !String(git(["rev-parse", "--verify", "HEAD"], repoDir) ?? "").trim();
  } catch {
    isEmptyRepo = true;
  }
  if (existsSync(join(repoDir, ".claude-plugin", "marketplace.json"))) {
    return {
      ok: false,
      error: `${url} is already a handbook — run /handbook:join ${url} to point this machine at it instead of scaffolding it again`,
    };
  }
  const { skipped } = writeSkeletonPreserving(
    repoDir,
    skeletonFiles(marketplaceName, url, hostFromUrl(url), commitPrefix, withCi),
  );
  // An empty repository has no default branch to open a merge request against, so the
  // first commit has to go straight to it. Everywhere else the scaffold arrives the way
  // every skill will: a branch and a merge request. Pushing to the default branch needs
  // write access to a protected branch, which on most teams means Maintainer, while
  // pushing a new branch is something almost any member can do — and the person setting
  // the handbook up is not necessarily the person who administers the project.
  const scaffoldBranch = `${branchPrefix}scaffold`;
  const direct = isEmptyRepo;
  try {
    if (!direct) git(["checkout", "-b", scaffoldBranch], repoDir);
    git(["add", "-A"], repoDir);
    // Commit as the developer, not as a stand-in address. publish has always done this
    // because a forge that checks commit authors rejects anything else, and init pushes
    // to the same repository under the same rules. "TeamHandbook@localhost" was an
    // author waiting to be refused.
    git([...identity, "commit", "-m", `${commitPrefix}chore: scaffold team skill base`], repoDir);
    git(["push", "origin", direct ? `HEAD:${branch}` : `HEAD:${scaffoldBranch}`], repoDir);
  } catch (err) {
    return { ok: false, error: pushFailureReason(url, direct ? branch : scaffoldBranch, err) };
  }
  let prUrl: string | null = null;
  let prError: string | undefined;
  if (!direct) {
    const opened = openPr(
      url,
      scaffoldBranch,
      "chore: set up the team handbook",
      "Scaffolds this repository as a Claude Code marketplace so approved skills can be distributed from it: marketplace manifest, plugin manifest, the version-bump CI, and a `skills/` directory.\n\nOpened by TeamHandbook.",
      repoDir,
      forge,
    );
    prUrl = opened.url;
    prError = opened.error;
  }
  saveTeamConfig(
    {
      repoUrl: url,
      marketplaceName,
      initializedAt: now,
      ...(branchPrefix !== DEFAULT_BRANCH_PREFIX ? { branchPrefix } : {}),
      ...(commitPrefix ? { commitPrefix: commitPrefix.trim() } : {}),
    },
    home,
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
    ...(prUrl ? { prUrl } : {}),
    ...(prError ? { prError } : {}),
    ...(!direct && !prUrl ? { manualUrl: manualPrUrl(url, scaffoldBranch) ?? undefined } : {}),
  };
}

export function formatInitSuccess(result: InitResult): string {
  const isGitHub = !!result.url && (hostFromUrl(result.url) ?? "").includes("github");
  // No CI note any more: the version bump travels inside each skill's own merge
  // request, so nothing here depends on a token or on write access to a protected
  // branch. `--with-ci` is for repositories where skills also arrive by hand.
  return [
    "Team skill base initialized.",
    "",
    `  repository:  ${result.url}`,
    `  marketplace: ${result.name}`,
    ...(result.merged
      ? [`  pushed:      marketplace skeleton + version-bump CI, straight to ${result.branch} (the repo was empty)`]
      : [
          `  pushed:      marketplace skeleton + version-bump CI to branch ${result.branch}`,
          result.prUrl
            ? `  request:     ${result.prUrl}`
            : `  request:     open it here — ${result.manualUrl ?? `push ${result.branch} and open a request against ${result.defaultBranch}`}`,
          ...(result.prError ? [`               (could not open it automatically: ${result.prError})`] : []),
          `  NOT LIVE until that is merged into ${result.defaultBranch}. Share the message below after it is.`,
        ]),
    // Silence is the wrong signal here: a team whose README already said something
    // keeps it, and then the join instructions live nowhere unless they are told.
    ...(result.skipped?.length
      ? [
          `  left alone: ${result.skipped.join(", ")} (already had content)`,
          "               the handbook README explains how teammates join — if yours was kept,",
          "               copy that section across from skills/README.md or this output.",
        ]
      : []),
    `  config:      team repo saved to ${join(result.home ?? "", "config.json")}`,
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
    isGitHub
      ? "    brew install gh && gh auth login        # GitHub over HTTPS"
      : "    brew install glab && glab auth login    # GitLab over HTTPS,",
    ...(isGitHub ? [] : ["                                            # or add an SSH key to your account"]),
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
