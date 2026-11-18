import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HANDBOOK_MARKETPLACE, HANDBOOK_PLUGIN, installHandbookPlugin, runPluginOp } from "./plugin-install.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the Claude CLI that writes down its arguments and answers each call by the script given. */
function standIn(script: string): { program: string; calls: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "th-plugin-"));
  dirs.push(dir);
  const program = join(dir, "claude");
  writeFileSync(program, `#!/bin/sh\necho "$@" >> "${join(dir, "calls")}"\n${script}\n`);
  chmodSync(program, 0o755);
  return { program, calls: () => (readFileSync(join(dir, "calls"), "utf8").trim().split("\n")) };
}

describe("installing the handbook plugin", () => {
  it("given a CLI that accepts both steps, when the plugin is installed, then the marketplace is added before the plugin is installed", async () => {
    // given
    const cli = standIn("exit 0");

    // when
    const result = await installHandbookPlugin(cli.program, { PATH: "/usr/bin:/bin" }, tmpdir());

    // then
    expect(result).toEqual({ installed: true });
    expect(cli.calls()).toEqual([`plugin marketplace add ${HANDBOOK_MARKETPLACE}`, `plugin install ${HANDBOOK_PLUGIN}`]);
  });

  it("given a CLI that refuses the marketplace, when the plugin is installed, then it says what the CLI said and never tries the install", async () => {
    // given
    const cli = standIn('echo "marketplace unreachable" >&2\nexit 1');

    // when
    const result = await installHandbookPlugin(cli.program, { PATH: "/usr/bin:/bin" }, tmpdir());

    // then
    expect(result).toEqual({ installed: false, why: "marketplace unreachable" });
    expect(cli.calls()).toEqual([`plugin marketplace add ${HANDBOOK_MARKETPLACE}`]);
  });

  it("given a CLI whose refusal carries an address with a password, when the plugin is installed, then the reason has it masked", async () => {
    // given
    const cli = standIn('echo "cannot reach https://ada:hunter2@git.example.invalid/x" >&2\nexit 1');

    // when
    const result = await installHandbookPlugin(cli.program, { PATH: "/usr/bin:/bin" }, tmpdir());

    // then
    expect(result).toMatchObject({ installed: false });
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("given a CLI that does not answer in time, when the plugin is installed, then it says to try again or type the commands", async () => {
    // given
    const cli = standIn("sleep 30");

    // when
    const result = await installHandbookPlugin(cli.program, { PATH: "/usr/bin:/bin" }, tmpdir(), 300);

    // then
    expect(result).toMatchObject({ installed: false, why: expect.stringContaining("type the two commands") });
  });
});

describe("one of Claude Code's own plugin commands", () => {
  it("given a plugin the inventory lists, when it is turned off, then exactly claude plugin disable <id> -s <scope> runs and the answer names the command", async () => {
    // given
    const cli = standIn("exit 0");

    // when
    const result = await runPluginOp(cli.program, { PATH: "/usr/bin:/bin" }, tmpdir(), "disable", "payments-skills@payments-market", "user");

    // then
    expect(result).toEqual({ ok: true, command: "claude plugin disable payments-skills@payments-market" });
    expect(cli.calls()).toEqual(["plugin disable payments-skills@payments-market -s user"]);
  });

  it("given an id with a space, a leading dash, a semicolon or no marketplace, an unknown scope or an unknown command, when each is asked, then nothing runs", async () => {
    // given
    const cli = standIn("exit 0");

    // when
    const asked = await Promise.all([
      runPluginOp(cli.program, {}, tmpdir(), "disable", "two words@market", "user"),
      runPluginOp(cli.program, {}, tmpdir(), "disable", "-rf@market", "user"),
      runPluginOp(cli.program, {}, tmpdir(), "disable", "a;rm@market", "user"),
      runPluginOp(cli.program, {}, tmpdir(), "disable", "payments-skills", "user"),
      runPluginOp(cli.program, {}, tmpdir(), "disable", "payments-skills@payments-market", "everywhere"),
      runPluginOp(cli.program, {}, tmpdir(), "reinstall" as never, "payments-skills@payments-market", "user"),
    ]);

    // then
    expect(asked.every((r) => !r.ok)).toBe(true);
    expect(() => cli.calls()).toThrow();
  });

  it("given Claude Code refusing an uninstall with a password in its words, when it runs, then the reason is masked", async () => {
    // given
    const cli = standIn('echo "cannot reach https://ada:hunter2@git.example.invalid/x" >&2\nexit 1');

    // when
    const result = await runPluginOp(cli.program, { PATH: "/usr/bin:/bin" }, tmpdir(), "uninstall", "payments-skills@payments-market", "user");

    // then
    expect(result).toMatchObject({ ok: false, command: "claude plugin uninstall payments-skills@payments-market" });
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("given a plugin a known marketplace offers, when it is installed, then claude plugin install <id> runs with no scope, Claude Code's own default", async () => {
    // given
    const cli = standIn("exit 0");

    // when
    const result = await runPluginOp(cli.program, { PATH: "/usr/bin:/bin" }, tmpdir(), "install", "docs-kit@payments-market", "user");

    // then
    expect(result).toEqual({ ok: true, command: "claude plugin install docs-kit@payments-market" });
    expect(cli.calls()).toEqual(["plugin install docs-kit@payments-market"]);
  });

  it("given the check for updates, when it is run, then Claude Code is asked to refresh its marketplaces with no plugin named, and a refusal says what it said", async () => {
    // given
    const fine = standIn("exit 0");
    const refused = standIn('echo "Network is down"; exit 1');

    // when
    const ok = await runPluginOp(fine.program, { PATH: "/usr/bin:/bin" }, tmpdir(), "check", "", "user");
    const no = await runPluginOp(refused.program, { PATH: "/usr/bin:/bin" }, tmpdir(), "check", "", "user");

    // then
    expect(ok).toEqual({ ok: true, command: "claude plugin marketplace update" });
    expect(fine.calls()).toEqual(["plugin marketplace update"]);
    expect(no).toEqual({ ok: false, command: "claude plugin marketplace update", why: "Network is down" });
  });
});
