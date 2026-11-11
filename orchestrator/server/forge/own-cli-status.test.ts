import { describe, expect, it } from "vitest";
import { createOwnCliForge, OwnCliRefused } from "./own-cli.js";
import type { CliForge, CliResult, CliRun } from "./own-cli.js";
import type { CommitCheck, ForgeConfig } from "./types.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const LONG = "Held: the change writes outside the skills folder, ".repeat(5);
const CHECK: CommitCheck = { state: "failure", context: "teamhandbook/pushed-check", description: LONG };

/**
 * A stand-in gh, glab or tea: `answer` decides each call by its arguments, every call is recorded,
 * and nothing reaches a forge. tea's logins and version are answered as tea gives them.
 */
function cli(answer: (tool: string, args: string[]) => Partial<CliResult> | undefined = () => undefined) {
  const calls: { tool: string; args: string[]; input?: string }[] = [];
  const run: CliRun = async (tool, args, input) => {
    calls.push({ tool, args, ...(input ? { input } : {}) });
    if (tool === "tea" && args[0] === "--version") return { code: 0, stdout: "Version: \x1b[1m0.16.0\x1b[0m\n", stderr: "", missing: false };
    if (tool === "tea" && args[0] === "login") return { code: 0, stdout: JSON.stringify([{ name: "mine", url: "https://git.example.invalid:3000", user: "ada" }]), stderr: "", missing: false };
    return { code: 0, stdout: "{}", stderr: tool === "tea" ? "HTTP/1.1 201 Created\n" : "", missing: false, ...answer(tool, args) };
  };
  return { run, calls, writes: () => calls.filter((c) => c.args.includes("POST")) };
}

const forge = (kind: CliForge, apiUrl: string, run: CliRun) => createOwnCliForge({ repoId: "skills", kind, apiUrl, project: "acme/skills" } as ForgeConfig & { kind: CliForge }, "/unused", () => "/unused", async () => null, run);

describe("a commit status written with the person's own gh, glab or tea", () => {
  it("given gh signed in to github.com, when a check is written, then gh posts that one status on the commit, its description cut to 140 characters, and nothing else", async () => {
    const { run, calls, writes } = cli();

    await forge("github", "https://api.github.com", run).setCommitStatus!(SHA, CHECK);

    expect(calls[0]!.args).toEqual(["auth", "status", "--hostname", "github.com"]);
    expect(writes()).toEqual([
      { tool: "gh", args: ["api", "--hostname", "github.com", "-X", "POST", "-f", "state=failure", "-f", "context=teamhandbook/pushed-check", "-f", `description=${LONG.slice(0, 140)}`, `repos/acme/skills/statuses/${SHA}`] },
    ]);
  });

  it("given glab signed in to a self-managed GitLab on a port, when a check with no verdict is written, then GitLab is told it failed, under the check's name, on the project's path", async () => {
    const { run, writes } = cli();

    await forge("gitlab", "https://gitlab.example.invalid:8443/api/v4", run).setCommitStatus!(SHA, { state: "error", context: "teamhandbook/review-rules", description: "The review did not end in PASS or FAIL." });

    expect(writes()[0]!.args).toEqual(["api", "--hostname", "gitlab.example.invalid", "-X", "POST", "-f", "state=failed", "-f", "name=teamhandbook/review-rules", "-f", "description=The review did not end in PASS or FAIL.", `projects/acme%2Fskills/statuses/${SHA}`]);
  });

  it("given tea with a login for the Gitea's host and port, when a check is written, then tea posts it naming that login, the status as its body", async () => {
    const { run, writes } = cli();

    await forge("gitea", "https://git.example.invalid:3000/api/v1", run).setCommitStatus!(SHA, { state: "success", context: "teamhandbook/pushed-check", description: "Passed." });

    expect(writes()).toEqual([{ tool: "tea", args: ["api", "-i", "--login=mine", "-X", "POST", "-d", "@-", `repos/acme/skills/statuses/${SHA}`], input: JSON.stringify({ state: "success", context: "teamhandbook/pushed-check", description: "Passed." }) }]);
  });

  it("given the forge refusing the status, which tea answers with exit 0, when a check is written, then it fails with one line naming the CLI, the check, the commit and the forge's reason, with no response header in it, rather than passing quietly", async () => {
    const { run } = cli((tool, args) => (args.includes("POST") ? { stdout: '{"message":"token does not\nhave write:repository"}', stderr: "HTTP/1.1 403 Forbidden\nSet-Cookie: i_like_gitea=stand-in-session\n\n" } : undefined));

    const written = forge("gitea", "https://git.example.invalid:3000/api/v1", run).setCommitStatus!(SHA, CHECK);

    await expect(written).rejects.toBeInstanceOf(OwnCliRefused);
    await expect(written).rejects.toThrow(/^tea did not write the teamhandbook\/pushed-check check on 0123456: HTTP\/1\.1 403 [^\n]*token does not have write:repository[^\n]*$/);
    await expect(written).rejects.not.toThrow(/stand-in-session/);
  });

  it("given gh failing the write with its own exit, when a check is written, then it fails with gh's reason", async () => {
    const { run } = cli((tool, args) => (args.includes("POST") ? { code: 1, stderr: "HTTP 403: Resource not accessible by integration" } : undefined));

    await expect(forge("github", "https://api.github.com", run).setCommitStatus!(SHA, CHECK)).rejects.toThrow("gh did not write the teamhandbook/pushed-check check on 0123456: HTTP 403: Resource not accessible by integration");
  });

  it("given a short commit id, a check that is not the orchestrator's own, or gh not signed in, when a check is written, then it is refused and the CLI is never asked to write", async () => {
    const { run, writes } = cli();
    const signedOut = cli((tool, args) => (args[1] === "status" ? { code: 1 } : undefined));
    const github = forge("github", "https://api.github.com", run);

    await expect(github.setCommitStatus!(SHA.slice(0, 7), CHECK)).rejects.toThrow(/full commit id/);
    await expect(github.setCommitStatus!(SHA, { ...CHECK, context: "ci/merge-allowed" })).rejects.toThrow(/not one of the orchestrator's own checks/);
    await expect(forge("github", "https://api.github.com", signedOut.run).setCommitStatus!(SHA, CHECK)).rejects.toThrow(/not signed in to github\.com; sign in with `gh auth login --hostname github\.com`/);
    expect([...writes(), ...signedOut.writes()]).toEqual([]);
  });
});
