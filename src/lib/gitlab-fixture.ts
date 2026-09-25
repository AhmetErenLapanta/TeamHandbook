import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A TEST FIXTURE, not product code: a local bare repository that refuses a push the way
 * a GitLab project with push rules refuses one.
 *
 * Every existing test drives the forge through an injected runner, so the only thing
 * they can measure is that the product asks for the right command. The first run against
 * a real GitLab project produced four defects none of them could see, because what the
 * product actually parses is the SENTENCE the server refuses with, and no test owned one
 * that a server had produced. A pre-receive hook is the same mechanism GitLab uses - git
 * refuses the push when the hook exits non-zero - so a repository built here rejects
 * through the same path, and the CLI reads the same bytes it will read in the field.
 */

/** Which rules the project enforces. A rule left out is a rule the project does not have. */
export interface GitLabPushRules {
  /** Branch name pattern, applied to every branch except the default one. */
  branchName?: string;
  /** Commit message pattern, applied to the subject of every new commit. */
  commitMessage?: string;
  /** Author and committer email pattern, applied to every new commit. */
  email?: string;
  /** Whether the default branch is protected against a direct push. */
  protectedDefaultBranch?: boolean;
}

export interface GitLabRepoOptions {
  defaultBranch?: string;
  rules?: GitLabPushRules;
  /** The files the project already has, or null for a repository with no commits yet. */
  seed?: Record<string, string> | null;
}

export interface CommitIdentity {
  name: string;
  email: string;
}

export interface PushAttempt {
  ok: boolean;
  /** git's own output, as the product's runGit would meet it. */
  stderr: string;
}

export interface GitLabRepo {
  /** The clone URL, which for a local bare repository is its path. */
  url: string;
  defaultBranch: string;
  /** What a maintainer merging the request amounts to: the branch becomes the default
   * branch's new tip. Done through the ref rather than a push, because a merge performed
   * on the server is not a push and is not what the hook screens. */
  mergeIntoDefault(branch: string): void;
  branches(): string[];
  filesOn(ref: string): string;
  fileOn(ref: string, path: string): string;
  /** Push one commit straight at the hook, with no product code in between. A rule that
   * is never observed refusing is a rule the harness only believes in. */
  pushAttempt(options: { branch: string; message: string; identity: CommitIdentity }): PushAttempt;
  remove(): void;
}

// Patterns reach the hook through the repository's own config rather than being written
// into the script, so one hook text serves every rule combination and no pattern has to
// survive shell quoting twice.
const HOOK = `#!/bin/sh
set -u

rule() { git config --get "pushrule.$1" 2>/dev/null || true; }

default_branch=$(rule defaultbranch)
protected=$(rule protected)
branch_pattern=$(rule branchname)
message_pattern=$(rule commitmessage)
email_pattern=$(rule email)

# Only the sentence. git prefixes every line a hook writes with "remote: " and adds the
# "! [remote rejected] ... (pre-receive hook declined)" verdict itself, so echoing either
# would produce a line no server ever sends.
refuse() {
  echo "GitLab: $1"
  exit 1
}

zero=0000000000000000000000000000000000000000

while read -r old new ref; do
  case "$ref" in
    refs/heads/*) ;;
    *) continue ;;
  esac
  branch=\${ref#refs/heads/}
  if [ "$new" = "$zero" ]; then
    continue
  fi

  if [ "$protected" = "true" ] && [ "$branch" = "$default_branch" ]; then
    refuse "You are not allowed to push code to protected branches on this project."
  fi

  # The default branch is exempt from the naming rule, as it is on the server. Screening
  # it here would hide the case the field produced: a push refused for its commit author
  # while the branch was the default one, which has no name to be refused for.
  if [ -n "$branch_pattern" ] && [ "$branch" != "$default_branch" ]; then
    printf '%s' "$branch" | grep -Eq "$branch_pattern" ||
      refuse "Branch name '$branch' does not follow the pattern '$branch_pattern'"
  fi

  if [ "$old" = "$zero" ]; then
    revs=$(git rev-list "$new" --not --all)
  else
    revs=$(git rev-list "$old..$new")
  fi

  for sha in $revs; do
    if [ -n "$message_pattern" ]; then
      subject=$(git log -1 --format=%s "$sha")
      printf '%s' "$subject" | grep -Eq "$message_pattern" ||
        refuse "Commit message does not follow the pattern '$message_pattern'"
    fi
    if [ -n "$email_pattern" ]; then
      author=$(git log -1 --format=%ae "$sha")
      printf '%s' "$author" | grep -Eq "$email_pattern" ||
        refuse "Author's email '$author' does not follow the pattern '$email_pattern'"
      committer=$(git log -1 --format=%ce "$sha")
      printf '%s' "$committer" | grep -Eq "$email_pattern" ||
        refuse "Committer's email '$committer' does not follow the pattern '$email_pattern'"
    fi
  done
done
exit 0
`;

// stderr is captured rather than inherited: git narrates a push on it, and the narration
// of the fixture's own setup would be read as a case's output.
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
}

function installRules(bare: string, defaultBranch: string, rules: GitLabPushRules): void {
  const hooks = join(bare, "hooks");
  mkdirSync(hooks, { recursive: true });
  const script = join(hooks, "pre-receive");
  writeFileSync(script, HOOK);
  // A hook git cannot execute is a hook git skips without a word, which would leave every
  // rule below silently unenforced and every case in this file passing for the wrong reason.
  chmodSync(script, 0o755);
  // Named explicitly because a global core.hooksPath on the machine running the suite
  // would otherwise point git at somebody else's hooks directory.
  git(bare, ["config", "core.hooksPath", "hooks"]);
  git(bare, ["config", "pushrule.defaultbranch", defaultBranch]);
  if (rules.protectedDefaultBranch) git(bare, ["config", "pushrule.protected", "true"]);
  if (rules.branchName) git(bare, ["config", "pushrule.branchname", rules.branchName]);
  if (rules.commitMessage) git(bare, ["config", "pushrule.commitmessage", rules.commitMessage]);
  if (rules.email) git(bare, ["config", "pushrule.email", rules.email]);
}

export function createGitLabRepo(options: GitLabRepoOptions = {}): GitLabRepo {
  const defaultBranch = options.defaultBranch ?? "master";
  const seed = options.seed === undefined ? { "README.md": "# our repo\n" } : options.seed;
  const bare = mkdtempSync(join(tmpdir(), "forge-project-"));
  execFileSync("git", ["init", "--bare", "-b", defaultBranch, bare], { stdio: "ignore" });
  if (seed) {
    // Seeded before the rules are installed: the project's own history predates the rules
    // its administrator switched on, and screening it would refuse the fixture's own setup.
    const work = mkdtempSync(join(tmpdir(), "forge-seed-"));
    try {
      execFileSync("git", ["-C", work, "init", "-b", defaultBranch], { stdio: "ignore" });
      writeTree(work, seed);
      git(work, ["add", "-A"]);
      git(work, ["-c", "user.name=Seed", "-c", "user.email=seed@acme.example", "commit", "-m", "seed"]);
      git(work, ["push", bare, defaultBranch]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  installRules(bare, defaultBranch, options.rules ?? {});

  return {
    url: bare,
    defaultBranch,
    mergeIntoDefault(branch) {
      git(bare, ["update-ref", `refs/heads/${defaultBranch}`, `refs/heads/${branch}`]);
    },
    branches() {
      return git(bare, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .split("\n")
        .filter(Boolean);
    },
    filesOn(ref) {
      return git(bare, ["ls-tree", "-r", "--name-only", ref]);
    },
    fileOn(ref, path) {
      return git(bare, ["show", `${ref}:${path}`]);
    },
    pushAttempt({ branch, message, identity }) {
      const work = mkdtempSync(join(tmpdir(), "forge-push-"));
      try {
        execFileSync("git", ["clone", bare, join(work, "repo")], { stdio: "ignore" });
        const repo = join(work, "repo");
        writeFileSync(join(repo, "note.txt"), `${branch}\n`);
        if (branch !== defaultBranch) git(repo, ["checkout", "-b", branch]);
        git(repo, ["add", "-A"]);
        git(repo, [
          "-c",
          `user.name=${identity.name}`,
          "-c",
          `user.email=${identity.email}`,
          "commit",
          "-m",
          message,
        ]);
        try {
          execFileSync("git", ["-C", repo, "push", "origin", `HEAD:${branch}`], {
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
          });
          return { ok: true, stderr: "" };
        } catch (err) {
          return { ok: false, stderr: String((err as { stderr?: string }).stderr ?? err) };
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    remove() {
      rmSync(bare, { recursive: true, force: true });
    },
  };
}
