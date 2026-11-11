import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliSignInState, SignInRefused, startCliSignIn } from "./cli-sign-in.js";
import type { CliSignIn } from "./cli-sign-in.js";

afterEach(() => vi.unstubAllEnvs());

/**
 * A stand-in gh on PATH that acts out a browser sign-in: it prints its one-time code and the page
 * to enter it on, as gh does with no terminal, then waits until the test approves or denies it.
 * Every start and its arguments are written down, and so is whether a GH_TOKEN reached it.
 */
function standInGh(page = "https://github.com/login/device") {
  const dir = mkdtempSync(join(tmpdir(), "stand-in-gh-"));
  const script = [
    "#!/bin/sh",
    `echo "$*" >> "${dir}/started"`,
    `echo "\${GH_TOKEN:-none}" > "${dir}/token"`,
    "echo '! First copy your one-time code: ABCD-1234' >&2",
    `echo 'Open this URL to continue in your web browser: ${page}' >&2`,
    `while [ ! -f "${dir}/answer" ]; do sleep 0.05; done`,
    `if [ "$(cat "${dir}/answer")" = deny ]; then echo 'failed to authenticate via web browser: access_denied' >&2; exit 1; fi`,
    "echo '✓ Authentication complete.' >&2",
    "echo '✓ Logged in as ada' >&2",
  ].join("\n");
  writeFileSync(join(dir, "gh"), `${script}\n`);
  chmodSync(join(dir, "gh"), 0o755);
  vi.stubEnv("PATH", `${dir}${delimiter}${process.env.PATH}`);
  return { answer: (what: "approve" | "deny") => writeFileSync(join(dir, "answer"), what), started: () => readFileSync(join(dir, "started"), "utf8").trim().split("\n"), token: () => readFileSync(join(dir, "token"), "utf8").trim() };
}

/** The sign-in's state once `ready` holds, as the card reads it by asking again; a loaded machine starts a new script slowly. */
async function once(kind: "github" | "gitlab", host: string, ready: (state: CliSignIn) => boolean): Promise<CliSignIn> {
  for (let n = 0; n < 600; n++) {
    const state = cliSignInState(kind, host);
    if (ready(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the sign-in stayed ${JSON.stringify(cliSignInState(kind, host))}`);
}
const settled = (kind: "github" | "gitlab", host: string) => once(kind, host, (state) => state.state !== "waiting");
const withCode = (kind: "github" | "gitlab", host: string) => once(kind, host, (state) => state.state === "waiting" && state.code !== null && state.url !== null);

describe("signing the person's own gh in from the card", () => {
  it("given gh on this machine, when the sign-in starts and the person approves it in the browser, then the card gets the code and the page, then the account, and no token of the environment reaches gh", async () => {
    const gh = standInGh();
    vi.stubEnv("GH_TOKEN", "stand-in-env-token");

    await startCliSignIn("github", "github.com");
    const waiting = await withCode("github", "github.com");
    gh.answer("approve");
    const done = await settled("github", "github.com");

    expect(waiting).toEqual({ state: "waiting", code: "ABCD-1234", url: "https://github.com/login/device" });
    expect(done).toEqual({ state: "done", account: "ada" });
    expect(gh.started()).toEqual(["auth login --hostname github.com --web"]);
    expect(gh.token()).toBe("none");
  });

  it("given a sign-in already waiting, when Sign in is pressed again, then the same code comes back and gh is not started twice", async () => {
    const gh = standInGh("https://twice.example.invalid/login/device");

    await startCliSignIn("github", "twice.example.invalid");
    const first = await withCode("github", "twice.example.invalid");
    const second = await startCliSignIn("github", "twice.example.invalid");
    gh.answer("approve");
    await settled("github", "twice.example.invalid");

    expect(second).toEqual(first);
    expect(gh.started()).toHaveLength(1);
  });

  it("given the person denying it in the browser, when gh ends, then the card says gh's reason and both ways to try again", async () => {
    const gh = standInGh();

    await startCliSignIn("github", "denied.example.invalid");
    gh.answer("deny");
    const failed = await settled("github", "denied.example.invalid");

    expect(failed).toEqual({ state: "failed", installed: true, error: "gh did not sign in to denied.example.invalid: failed to authenticate via web browser: access_denied; press Sign in again, or run `gh auth login --hostname denied.example.invalid` in a terminal" });
  });

  it("given no answer in the browser within the time a code lasts, when the time runs out, then gh is stopped and the card says to press Sign in again", async () => {
    standInGh();

    await startCliSignIn("github", "slow.example.invalid", 300);
    const failed = await settled("github", "slow.example.invalid");

    expect(failed).toMatchObject({ state: "failed", installed: true, error: expect.stringMatching(/^the sign-in to slow\.example\.invalid was not finished in .*; press Sign in again$/) });
  });

  it("given glab not on this machine, when its sign-in starts, then the card says where to install it and to check again", async () => {
    // A PATH holding sh alone, so no glab of this machine's is found.
    const bin = mkdtempSync(join(tmpdir(), "no-glab-"));
    symlinkSync(execFileSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).trim(), join(bin, "sh"));
    vi.stubEnv("PATH", bin);

    const failed = await startCliSignIn("gitlab", "gitlab.com");

    expect(failed).toEqual({ state: "failed", installed: false, error: "GitLab's glab is not on this machine; install it from https://gitlab.com/gitlab-org/cli, then press Check again" });
  });

  it("given a host that starts with a dash or is no host name, when its sign-in starts, then it is refused as a bad request before gh is started", async () => {
    const gh = standInGh();

    for (const host of ["-oProxyCommand=x", "github.com evil", "github.com/x", ""]) {
      await expect(startCliSignIn("github", host)).rejects.toMatchObject({ status: 400 });
      await expect(startCliSignIn("github", host)).rejects.toBeInstanceOf(SignInRefused);
    }
    expect(() => gh.started()).toThrow();
  });

  it("given gh naming a page on another host to enter the code on, when the sign-in waits, then the page is no link, only words for the person to read", async () => {
    const gh = standInGh("https://elsewhere.example.invalid/login/device");

    await startCliSignIn("github", "page.example.invalid");
    const waiting = await once("github", "page.example.invalid", (state) => state.state === "waiting" && state.code !== null && state.note !== undefined);
    gh.answer("deny");

    expect(waiting).toMatchObject({ state: "waiting", code: "ABCD-1234", url: null, note: "the CLI asks you to open https://elsewhere.example.invalid/login/device" });
  });
});
