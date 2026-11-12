import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HANDBOOK_MARKETPLACE, HANDBOOK_PLUGIN, installHandbookPlugin } from "./plugin-install.js";

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
