import { describe, it, expect } from "vitest";
import { openedRequestUrl, openPr } from "./forge.js";
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
      "--reviewer=ada,grace",
      "--label=skills,type::docs",
    ]);
  });

  it("given empty lists, when the request is opened, then no assignment flag is added at all", () => {
    const { forge, calls } = scripted(`${MR}\n`, `${PR}\n`);

    openPr(GITLAB, "TEAM-12", "t", "b", "/repo", forge, { reviewers: [], labels: [] });
    openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge);

    expect(calls[0]).toEqual(["mr", "create", "--source-branch", "TEAM-12", "--title", "t", "--description", "b", "--yes"]);
    expect(calls[1]).toEqual(["pr", "create", "--head", "TEAM-12", "--title", "t", "--body", "b"]);
  });

  it("given only labels, when the request is opened, then no reviewer flag is added", () => {
    const { forge, calls } = scripted(`${MR}\n`);

    openPr(GITLAB, "TEAM-12", "t", "b", "/repo", forge, { reviewers: [], labels: ["skills"] });

    expect(calls[0]).toContain("--label=skills");
    expect(calls[0]!.some((arg) => arg.startsWith("--reviewer"))).toBe(false);
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
    expect(opened).toEqual({ url: PR, unassigned: "pull request update failed: could not request reviewer: 'adaa' not found" });
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

  it("given a retry that fails as well, when it is over, then no request is claimed and both reasons are kept", () => {
    const { forge, calls } = scripted({ stderr: "label not found\n" }, { stderr: "HTTP 401: Bad credentials\n" });

    const opened = openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge, ASSIGNED);

    expect(calls).toHaveLength(2);
    expect(opened).toEqual({ url: null, error: "HTTP 401: Bad credentials", unassigned: "label not found" });
  });

  it("given no assignment, when the forge refuses, then it is asked once and only once", () => {
    const { forge, calls } = scripted({ stderr: "HTTP 401: Bad credentials\n" });

    const opened = openPr(GITHUB, "TEAM-12", "t", "b", "/repo", forge, { reviewers: [], labels: [] });

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
    const { forge } = scripted({ stderr: "could not create the request\nhttps://github.com/acme/skills/pull/3\n" });

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
