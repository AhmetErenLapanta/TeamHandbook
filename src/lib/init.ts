import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeRemoteUrl, slugifySkillName } from "./distill.js";
import { handbookHome } from "./session-state.js";

export interface TeamConfig {
  repoUrl: string;
  marketplaceName: string;
  initializedAt?: string;
  joinedAt?: string;
}

export function loadTeamConfig(home: string = handbookHome()): TeamConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    const team = parsed?.team;
    if (typeof team?.repoUrl === "string" && typeof team?.marketplaceName === "string") {
      return team;
    }
  } catch {
    // no config yet
  }
  return null;
}

export function saveTeamConfig(team: TeamConfig, home: string = handbookHome()): void {
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) config = parsed;
  } catch {
    // start from an empty config
  }
  config.team = team;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2) + "\n");
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
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_COMMIT_MESSAGE !~ /^ci: bump plugin version/'
  script:
    - node scripts/bump-version.mjs
    - git config user.name "handbook-ci"
    - git config user.email "handbook-ci@noreply.invalid"
    - git commit -am "ci: bump plugin version"
    - git push "https://oauth2:\${TEAMHANDBOOK_CI_TOKEN}@\${CI_SERVER_HOST}/\${CI_PROJECT_PATH}.git" "HEAD:\${CI_DEFAULT_BRANCH}"
`;

function readmeFor(name: string, url: string): string {
  return `# ${name}

Your team's skill base: approved skills distilled from real error-to-fix coding sessions
by TeamHandbook. This repository is a Claude Code plugin marketplace; every merge reaches
all subscribed teammates automatically.

## Consume skills (no TeamHandbook needed)

\`\`\`
/plugin marketplace add ${url}
/plugin install ${name}
\`\`\`

## Produce skills (TeamHandbook engine required)

\`\`\`
/handbook:join ${url}
\`\`\`

## How updates flow

Every merge to the default branch bumps the plugin version via CI
(\`scripts/bump-version.mjs\`), which triggers Claude Code's background marketplace
update on each teammate's machine. Skills live under \`skills/\`, one directory per
skill (\`SKILL.md\` plus its \`grounded-case.json\` regression anchor).
`;
}

export function skeletonFiles(name: string, url: string, host: string | null): Record<string, string> {
  const files: Record<string, string> = {
    ".claude-plugin/marketplace.json":
      JSON.stringify(
        {
          name,
          owner: { name: `${name} maintainers` },
          plugins: [
            {
              name,
              source: "./",
              description: "Approved team skills distilled from real error-to-fix sessions by TeamHandbook.",
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
          description: "Approved team skills distilled from real error-to-fix sessions by TeamHandbook.",
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

export type GitRunner = (args: string[], cwd: string) => void;

export function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
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
  const marketplaceName = slugifySkillName(name ?? repoNameFromUrl(url) ?? "");
  if (!marketplaceName) {
    return { ok: false, error: `cannot derive a marketplace name from "${url}"; pass --name` };
  }
  if (loadTeamConfig(home)) {
    return { ok: false, error: "a team repository is already configured; edit config.json to re-init" };
  }
  const workdir = mkdtempSync(join(tmpdir(), "handbook-init-"));
  writeSkeleton(workdir, skeletonFiles(marketplaceName, url, hostFromUrl(url)));
  try {
    git(["init", "-b", "main"], workdir);
    git(["add", "-A"], workdir);
    git(
      ["-c", "user.name=TeamHandbook", "-c", "user.email=TeamHandbook@localhost", "commit", "-m", "chore: scaffold team skill base"],
      workdir,
    );
    git(["remote", "add", "origin", url], workdir);
    git(["push", "-u", "origin", "main"], workdir);
  } catch (err) {
    return { ok: false, error: `git failed (is the target repo empty and reachable?): ${String(err)}` };
  }
  saveTeamConfig({ repoUrl: url, marketplaceName, initializedAt: now }, home);
  return { ok: true, name: marketplaceName, url, home };
}

export function formatInitSuccess(result: InitResult): string {
  return [
    "Team skill base initialized.",
    "",
    `  repository:  ${result.url}`,
    `  marketplace: ${result.name}`,
    "  pushed:      marketplace skeleton + version-bump CI (branch main)",
    `  config:      team repo saved to ${join(result.home ?? "", "config.json")}`,
    "",
    "Tell your teammates who will PRODUCE skills to run:",
    "",
    `  /handbook:join ${result.url}`,
    "",
    "Teammates who only want to CONSUME skills need two built-in commands instead:",
    "",
    `  /plugin marketplace add ${result.url}`,
    `  /plugin install ${result.name}`,
  ].join("\n");
}
