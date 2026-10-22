import { describe, it, expect, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { assignmentFailure, forgeSignInProblem, openedRequestUrl, openPr, runForge } from "./forge.js";
import type { ForgeRunner, RequestAssignment } from "./forge.js";

const GITLAB = "git@gitlab.com:acme/skills.git";
const GITHUB = "git@github.com:acme/skills.git";
const MR = "https://gitlab.com/acme/skills/-/merge_requests/12";
const PR = "https://github.com/acme/skills/pull/12";
const ASSIGNED: RequestAssignment = { reviewers: ["ada", "grace"], labels: ["skills", "type::docs"] };

/** A forge that answers each call in turn with the next reply: a string is what the CLI
 * printed, an object is the failure execFileSync throws, stdout and stderr included. */
function scripted(...replies: Array<string | { code?: string; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  const forge: ForgeRunner = (_tool, args) => {
    calls.push(args);
    const reply = replies[calls.length - 1];
    if (reply === undefined) throw new Error("no reply scripted for this call");
    if (typeof reply === "string") return reply;
    throw Object.assign(new Error("Command failed"), reply);
  };
  return { forge, calls };
}

describe("the assignment on the command line", () => {
  it("given reviewers and labels on GitLab, when the request is opened, then each list travels as one equals-form flag", () => {
    const { forge, calls } = scripted(`${MR}\n`);

    const opened = openPr(GITLAB, "TEAM-12", "t", "b", "/repo", forge, ASSIGNED);

    expect(opened).toEqual({ url: MR });
    expect(calls).toEqual([
      [
        "mr",
        "create",
        "--source-branch",
        "TEAM-12",
        "--title",
        "t",
        "--description",
        "b",
        "--assignee=@me",
        "--reviewer=ada,grace",
        "--label=skills,type::docs",
        "--yes",
      ],
    ]);
  });

  it("given reviewers and labels on GitHub, when the request is opened, then gh is given the same two flags", () => {
    const { forge, calls } = scripted(`${PR}\n`);

    openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge, ASSIGNED);

    expect(calls[0]).toEqual([
      "pr",
      "create",
      "--head",
      "TEAM-12",
      "--title",
      "t",
      "--body",
      "b",
      "--assignee=@me",
      "--reviewer=ada,grace",
      "--label=skills,type::docs",
    ]);
  });

  it("given empty lists, when the request is opened, then no reviewer or label flag is added at all", () => {
    const { forge, calls } = scripted(`${MR}\n`, `${PR}\n`);

    openPr(GITLAB, "TEAM-12", "t", "b", "/repo", forge, { reviewers: [], labels: [] });
    openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge);

    expect(calls[0]).toEqual(["mr", "create", "--source-branch", "TEAM-12", "--title", "t", "--description", "b", "--assignee=@me", "--yes"]);
    expect(calls[1]).toEqual(["pr", "create", "--head", "TEAM-12", "--title", "t", "--body", "b", "--assignee=@me"]);
  });

  it("given only labels, when the request is opened, then no reviewer flag is added", () => {
    const { forge, calls } = scripted(`${MR}\n`);

    openPr(GITLAB, "TEAM-12", "t", "b", "/repo", forge, { reviewers: [], labels: ["skills"] });

    expect(calls[0]).toContain("--label=skills");
    expect(calls[0]!.some((arg) => arg.startsWith("--reviewer"))).toBe(false);
  });
});

describe("the request is assigned to whoever opens it", () => {
  const NONE: RequestAssignment = { reviewers: [], labels: [] };
  const assigneeFlags = (args: string[] | undefined) => (args ?? []).filter((arg) => arg.startsWith("--assignee"));

  it.each([
    ["GitLab", GITLAB, MR],
    ["GitHub", GITHUB, PR],
  ])("given %s and a team file that records nobody, when the request is opened, then it asks for the signed-in account as assignee", (_forge, repo, url) => {
    const { forge, calls } = scripted(`${url}\n`);

    expect(openPr(repo, "TEAM-12", "t", "b", "/repo", forge, NONE)).toEqual({ url });
    expect(assigneeFlags(calls[0])).toEqual(["--assignee=@me"]);
  });

  it.each([
    ["empty", ""],
    ["blank", "  "],
  ])("given an %s assignee, when the request is opened, then no assignee flag is added", (_name, assignee) => {
    const { forge, calls } = scripted(`${MR}\n`, `${PR}\n`);

    openPr(GITLAB, "TEAM-12", "t", "b", "/repo", forge, ASSIGNED, assignee);
    openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge, NONE, assignee);

    expect(calls.map(assigneeFlags)).toEqual([[], []]);
  });

  it("given glab refusing the assignee before it creates anything, when the request is opened, then it is asked once more without it", () => {
    const { forge, calls } = scripted({ stderr: "error resolving assignee usernames: 401 Unauthorized\n" }, `${MR}\n`);

    const opened = openPr(GITLAB, "TEAM-12", "t", "b", "/repo", forge, NONE);

    expect(opened).toEqual({ url: MR, unassigned: "error resolving assignee usernames: 401 Unauthorized" });
    expect(calls).toHaveLength(2);
    expect(assigneeFlags(calls[1])).toEqual([]);
  });

  it("given gh opening the request before the assignee is refused, when it fails, then nothing is retried and that request is the result", () => {
    const { forge, calls } = scripted({
      stdout: `${PR}\n`,
      stderr: "pull request update failed: could not assign user: 'me' not found\n",
    });

    const opened = openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge, NONE);

    expect(calls).toHaveLength(1);
    expect(opened).toEqual({ url: PR, unassigned: "pull request update failed: could not assign user: 'me' not found", partial: true });
  });

  it("given no lists, a first attempt lost to the network and a retry told the request is open, when it is over, then no third request is asked for and nothing is said to be refused", () => {
    const { forge, calls } = scripted(
      { stderr: "read tcp [::1]:58906->[::1]:443: read: connection reset by peer.\n" },
      { stderr: "409 Conflict {message: [Another open merge request already exists for this source branch: !12]}\n" },
    );

    const opened = openPr(GITLAB, "TEAM-12", "t", "b", "/repo", forge, NONE);

    expect(calls).toHaveLength(2);
    expect(opened).toEqual({ url: MR, existing: true });
  });

  it("given no lists and a network error on both attempts, when it is over, then nothing is said to be refused", () => {
    // measured with glab: the local port in the message differs between two attempts
    const { forge, calls } = scripted(
      { stderr: "read tcp [::1]:58906->[::1]:443: read: connection reset by peer.\n" },
      { stderr: "read tcp [::1]:58910->[::1]:443: read: connection reset by peer.\n" },
    );

    const opened = openPr(GITLAB, "TEAM-12", "t", "b", "/repo", forge, NONE);

    expect(calls).toHaveLength(2);
    expect(opened).toEqual({ url: null, error: "read tcp [::1]:58910->[::1]:443: read: connection reset by peer." });
  });

  it("given no lists and a refusal on the default path, when the request is opened, then it is asked twice and never a third time", () => {
    const { forge, calls } = scripted({ stderr: "HTTP 401: Bad credentials\n" }, { stderr: "HTTP 401: Bad credentials\n" });

    const opened = openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--assignee=@me");
    expect(calls[1]!.some((arg) => arg.startsWith("--assignee"))).toBe(false);
    expect(opened).toEqual({ url: null, error: "HTTP 401: Bad credentials" });
  });
});

describe("an assignment the forge refuses", () => {
  it("given a refusal before anything was opened, when the request is opened, then it is asked once more without the assignment", () => {
    // glab resolves usernames before it creates anything
    const { forge, calls } = scripted({ stderr: "failed to find user by name : adaa\n" }, `${MR}\n`);

    const opened = openPr(GITLAB, "TEAM-12", "t", "b", "/repo", forge, ASSIGNED);

    expect(opened).toEqual({ url: MR, unassigned: "failed to find user by name : adaa" });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.some((arg) => arg.startsWith("--reviewer") || arg.startsWith("--label"))).toBe(false);
  });

  it("given a request opened before the reviewers were refused, when it fails, then nothing is retried and that request is the result", () => {
    // gh creates the pull request, prints it, then fails requesting the reviewers
    const { forge, calls } = scripted({
      stdout: `${PR}\n`,
      stderr: "pull request update failed: could not request reviewer: 'adaa' not found\n",
    });

    const opened = openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge, ASSIGNED);

    expect(calls).toHaveLength(1);
    expect(opened).toEqual({ url: PR, unassigned: "pull request update failed: could not request reviewer: 'adaa' not found", partial: true });
  });

  it("given a retry the forge answers with the request already open, when it fails, then nothing more is asked and that request is the result", () => {
    // the first call may have opened it without saying so, or it was open before this run
    const { forge, calls } = scripted(
      { stderr: "pull request create failed: something went wrong\n" },
      { stderr: `a pull request for branch "TEAM-12" into branch "main" already exists:\n${PR}\n` },
    );

    const opened = openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge, ASSIGNED);

    expect(calls).toHaveLength(2);
    expect(opened).toEqual({ url: PR, existing: true, unassigned: "pull request create failed: something went wrong" });
  });

  it("given lists and a retry that fails exactly as the first did, when it is over, then the team file is not blamed for it", () => {
    const { forge, calls } = scripted({ stderr: "HTTP 401: Bad credentials\n" }, { stderr: "HTTP 401: Bad credentials\n" });

    const opened = openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge, ASSIGNED);

    expect(calls).toHaveLength(2);
    expect(opened).toEqual({ url: null, error: "HTTP 401: Bad credentials" });
  });

  it("given lists and a retry that fails as well, when it is over, then no request is claimed and both reasons are kept", () => {
    const { forge, calls } = scripted({ stderr: "label not found\n" }, { stderr: "HTTP 401: Bad credentials\n" });

    const opened = openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge, ASSIGNED);

    expect(calls).toHaveLength(2);
    expect(opened).toEqual({ url: null, error: "HTTP 401: Bad credentials", unassigned: "label not found" });
  });

  it("given an empty assignee and no lists, which no caller passes, when the forge refuses, then nothing is dropped and it is asked once", () => {
    const { forge, calls } = scripted({ stderr: "HTTP 401: Bad credentials\n" });

    const opened = openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge, { reviewers: [], labels: [] }, "");

    expect(calls).toHaveLength(1);
    expect(opened).toEqual({ url: null, error: "HTTP 401: Bad credentials" });
  });

  it("given a forge that timed out, when the assignment was on it, then nothing is retried because the request may exist", () => {
    const { forge, calls } = scripted({ code: "ETIMEDOUT" });

    const opened = openPr(GITLAB, "TEAM-12", "t", "b", "/repo", forge, ASSIGNED);

    expect(calls).toHaveLength(1);
    expect(opened.url).toBeNull();
  });

  it("given no CLI, when the assignment was on it, then nothing is retried and the CLI is named", () => {
    const { forge, calls } = scripted({ code: "ENOENT" });

    const opened = openPr(GITLAB, "TEAM-12", "t", "b", "/repo", forge, ASSIGNED);

    expect(calls).toHaveLength(1);
    expect(opened).toEqual({ url: null, error: "the glab CLI is not installed" });
  });
});

describe("a request already open for the branch", () => {
  const alreadyOpen = { stderr: `a pull request for branch "TEAM-12" into branch "main" already exists:\n${PR}\n` };

  it("given an assignment, when the first call is refused as a second request, then it is asked once and the open request is the result", () => {
    const { forge, calls } = scripted(alreadyOpen);

    const opened = openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge, ASSIGNED);

    expect(calls).toHaveLength(1);
    expect(opened).toEqual({ url: PR, existing: true });
  });

  it("given no assignment, when the same refusal comes back, then the result is the same one", () => {
    const { forge } = scripted(alreadyOpen);

    expect(openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge)).toEqual({ url: PR, existing: true });
  });

  const gitlabConflict = { stderr: "409 Conflict {message: [Another open merge request already exists for this source branch: !12]}\n" };

  it("given GitLab's refusal, which names the request only as !12, when the request is opened, then its address is built from that and the repository", () => {
    const { forge, calls } = scripted(gitlabConflict);

    const opened = openPr(GITLAB, "TEAM-12", "t", "b", "/repo", forge, ASSIGNED);

    expect(calls).toHaveLength(1);
    expect(opened).toEqual({ url: MR, existing: true });
  });

  it("given that refusal on a repository with no web address, when the request is opened, then the forge's own sentence is kept with its !12", () => {
    const { forge } = scripted(gitlabConflict);

    expect(openPr("/srv/git/skills.git", "TEAM-12", "t", "b", "/repo", forge, ASSIGNED)).toEqual({
      url: null,
      existing: true,
      error:
        "a request for this branch is already open (409 Conflict {message: [Another open merge request already exists for this source branch: !12]})",
    });
  });

  it("given a refusal that ends on a bare address, when its reason is read, then the reason is the sentence before it", () => {
    const refusal = { stderr: "could not create the request\nhttps://github.com/acme/skills/compare/main...TEAM-12\n" };
    const { forge } = scripted(refusal, refusal);

    expect(openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge).error).toBe("could not create the request");
  });
});

describe("which address is the opened request", () => {
  it("given the repository's own request, when it is read, then it is found whatever the case or query", () => {
    expect(openedRequestUrl(`${MR}\n`, GITLAB)).toBe(MR);
    expect(openedRequestUrl("https://github.com/Acme/Skills/pull/12?notification=1", GITHUB)).toBe(
      "https://github.com/Acme/Skills/pull/12",
    );
    expect(openedRequestUrl(`${MR}\n`, "ssh://git@gitlab.com:2222/acme/skills.git")).toBe(MR);
  });

  it("given an address on another host or a compare link, when it is read, then neither is taken for the request", () => {
    expect(openedRequestUrl("error: could not resolve host https://example.com/acme/skills/pull/42\n", GITHUB)).toBeNull();
    expect(openedRequestUrl("https://github.com/acme/skills/pull/new/pull/7\n", GITHUB)).toBeNull();
    expect(openedRequestUrl(`${PR}\n`, GITLAB)).toBeNull();
    expect(openedRequestUrl("https://gitlab.com/acme/other/-/merge_requests/12\n", GITLAB)).toBeNull();
  });

  it("given a repository with no web address, when it is read, then the shape alone decides", () => {
    expect(openedRequestUrl(`${PR}\n`, "/srv/git/skills.git")).toBe(PR);
    expect(openedRequestUrl("https://github.com/acme/skills/pull/new/handbook-42\n", "/srv/git/skills.git")).toBeNull();
  });
});

describe("the forge CLI's own reporting", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function tree(root: string): Record<string, string> {
    const files: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else files[relative(root, path)] = readFileSync(path, "utf8");
      }
    };
    walk(root);
    return files;
  }

  it("given a user whose gh and glab report usage, when the product checks sign-in and opens a request with either CLI, then every call carries the reporting switched off and their config is untouched", () => {
    const userHome = mkdtempSync(join(tmpdir(), "handbook-user-"));
    // Where each real CLI keeps its settings, so a stand-in that changes them changes the same file.
    const configs = {
      gh: join(userHome, ".config", "gh", "config.yml"),
      glab: join(userHome, ...(platform() === "darwin" ? ["Library", "Application Support"] : [".config"]), "glab-cli", "config.yml"),
    };
    mkdirSync(dirname(configs.gh), { recursive: true });
    mkdirSync(dirname(configs.glab), { recursive: true });
    writeFileSync(configs.gh, "telemetry: enabled\n");
    writeFileSync(configs.glab, "telemetry: true\ncheck_update: true\n");
    const seen = mkdtempSync(join(tmpdir(), "handbook-forge-env-"));
    const bin = mkdtempSync(join(tmpdir(), "handbook-bin-"));
    for (const tool of ["gh", "glab"] as const) {
      // A stand-in that does what the real CLI does with a call that changes its settings: it
      // writes the user's config file. Any such call the product makes turns this test red.
      writeFileSync(
        join(bin, tool),
        "#!/bin/sh\n" +
          `echo "${tool} $*|GH_TELEMETRY=$GH_TELEMETRY|GLAB_SEND_TELEMETRY=$GLAB_SEND_TELEMETRY|GLAB_CHECK_UPDATE=$GLAB_CHECK_UPDATE" >> "$FORGE_ENV_SEEN/calls"\n` +
          'case "$1 $2" in\n' +
          '  "config get"|"config list") ;;\n' +
          `  config\\ *|"auth login"|"auth logout"|"auth refresh"|"auth setup-git"|"auth switch") echo "$*" >> "${configs[tool]}" ;;\n` +
          '  "pr create") echo https://github.com/acme/skills/pull/12 ;;\n' +
          '  "mr create") echo https://gitlab.com/acme/skills/-/merge_requests/12 ;;\n' +
          "esac\n",
      );
      chmodSync(join(bin, tool), 0o755);
    }
    vi.stubEnv("HOME", userHome);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("FORGE_ENV_SEEN", seen);
    vi.stubEnv("GLAB_SEND_TELEMETRY", "1");
    vi.stubEnv("GH_TELEMETRY", "enabled");
    const before = tree(userHome);

    for (const repoUrl of [GITHUB, GITLAB]) {
      expect(forgeSignInProblem(repoUrl, userHome, runForge)).toBeNull();
      expect(openPr(repoUrl, "TEAM-12", "t", "b", userHome, runForge, ASSIGNED).url).not.toBeNull();
    }

    expect(tree(userHome)).toEqual(before);
    const calls = readFileSync(join(seen, "calls"), "utf8").trim().split("\n");
    expect(new Set(calls.map((call) => call.split(" ")[0]))).toEqual(new Set(["gh", "glab"]));
    for (const call of calls) expect(call).toMatch(/\|GH_TELEMETRY=0\|GLAB_SEND_TELEMETRY=0\|GLAB_CHECK_UPDATE=false$/);
  });
});

describe("what a failed open's words say about its assignment", () => {
  const GLAB_EXISTS = { stderr: "409 Conflict {message: [Another open merge request already exists for this source branch: !12]}\n" };
  const RESET = (port: number) => ({ stderr: `read tcp [::1]:5890${port}->[::1]:443: read: connection reset by peer\n` });

  it.each([
    ["glab refusing a name, as its error handler prints it", "Failed to find user by name: adaa.", "lists"],
    ["gh on GitHub Enterprise refusing the assignee", "could not assign user: 'dev' not found", "assignee"],
    ["gh on GitHub Enterprise refusing a reviewer", "could not request reviewer: 'adaa' not found", "lists"],
    ["gh on GitHub Enterprise refusing a label", "could not add label: 'skills' not found", "lists"],
    ["a dropped connection", "read tcp [::1]:58901->[::1]:443: read: connection reset by peer", "fault"],
    ["a host that does not resolve", "dial tcp: lookup gitlab.example: no such host", "fault"],
    ["a refused token", "HTTP 401: Bad credentials", "fault"],
    ["a forge error", "500 Internal Server Error", "fault"],
    ["words this does not read", "pull request update failed: GraphQL: something went sideways", null],
  ])("given %s, when it is read, then it is taken for what it says", (_name, reason, kind) => {
    expect(assignmentFailure(reason)).toBe(kind);
  });

  it("given lists and a first attempt lost to the network, when the retry finds the request open, then the team file is not blamed", () => {
    const { forge, calls } = scripted(RESET(1), GLAB_EXISTS);

    const opened = openPr(GITLAB, "TEAM-12", "t", "b", "/repo", forge, ASSIGNED);

    expect(calls).toHaveLength(2);
    expect(opened).toEqual({ url: MR, existing: true });
  });

  it("given lists and a first attempt lost to the network, when the retry is lost too, then nothing is said to be refused", () => {
    const { forge, calls } = scripted(RESET(1), RESET(2));

    const opened = openPr(GITLAB, "TEAM-12", "t", "b", "/repo", forge, ASSIGNED);

    expect(calls).toHaveLength(2);
    expect(opened).toEqual({ url: null, error: "read tcp [::1]:58902->[::1]:443: read: connection reset by peer" });
  });

  it("given no lists and the assignee refused in words gh uses, when the retry finds the request open, then the refusal is kept", () => {
    const { forge, calls } = scripted(
      { stderr: "could not assign user: 'dev' not found\n" },
      { stderr: `a pull request for branch "TEAM-12" into branch "main" already exists:\n${PR}\n` },
    );

    const opened = openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge);

    expect(calls).toHaveLength(2);
    expect(opened).toEqual({ url: PR, existing: true, unassigned: "could not assign user: 'dev' not found" });
  });

  it("given no lists and the assignee refused in words gh uses, when the retry fails for another reason, then both reasons are kept", () => {
    const { forge, calls } = scripted({ stderr: "could not assign user: 'dev' not found\n" }, { stderr: "500 Internal Server Error\n" });

    const opened = openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge);

    expect(calls).toHaveLength(2);
    expect(opened).toEqual({ url: null, error: "500 Internal Server Error", unassigned: "could not assign user: 'dev' not found" });
  });
});
