import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupHere } from "./handbooks.js";
import type { SetupAnswer } from "./link.js";

describe("a person's own Claude Code on their machine, as the orchestrator's screen asks for it", { timeout: 60_000 }, () => {
  let root: string;
  let home: string;
  let claude: string;
  let ran: string;
  const where = () => ({ home, dataDir: join(home, "runner-data"), shadows: join(home, "runner-data", "shadow") });
  const notes = { projectId: "prj_notes", path: "~/notes", trusted: true };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "machine-handbooks-")));
    home = join(root, "home");
    ran = join(root, "claude-ran.txt");
    claude = join(root, "claude-stand-in");
    mkdirSync(join(home, ".claude", "skills", "review-checklist"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "review-checklist", "SKILL.md"), "---\nname: review-checklist\ndescription: Check a review.\n---\nCheck it.\n");
    mkdirSync(join(home, "notes", ".claude", "skills", "rota-check"), { recursive: true });
    writeFileSync(join(home, "notes", ".claude", "skills", "rota-check", "SKILL.md"), "---\nname: rota-check\ndescription: Check the rota.\n---\nCheck the rota.\n");
    mkdirSync(join(home, "runner-data"), { recursive: true });
    const plugin = join(home, ".claude", "plugins", "cache", "acme-market", "payments-skills", "1.4.0");
    mkdirSync(join(plugin, "skills", "add-endpoint"), { recursive: true });
    writeFileSync(join(plugin, "skills", "add-endpoint", "SKILL.md"), "---\nname: add-endpoint\n---\nAdd it.\n");
    const listed = JSON.stringify([{ id: "payments-skills@acme-market", version: "1.4.0", scope: "user", enabled: true, installPath: plugin }]);
    writeFileSync(claude, `#!/bin/sh\necho "$@" >> "${ran}"\nif [ "$1 $2" = "plugin list" ]; then echo '${listed}'; fi\nexit 0\n`);
    chmodSync(claude, 0o755);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("given the person's own skills, a project folder's and a plugin they installed, when the screen asks for the sources, then each comes back by its id, the folder named from the home and no path of the machine in the answer", async () => {
    // when
    const answer = await setupHere({ nonce: "n-1", want: "sources", folder: notes }, where(), { HOME: home, PATH: process.env.PATH }, claude);

    // then
    const sources = (answer as Extract<SetupAnswer, { sources: unknown }>).sources;
    expect(sources.map((s) => [s.id, s.skills.map((k) => k.name)])).toEqual([
      ["yours", ["review-checklist"]],
      ["folder:~/notes", ["rota-check"]],
      ["plugin:payments-skills@acme-market", ["add-endpoint"]],
    ]);
    expect(JSON.stringify(answer)).not.toContain(home);
  });

  it("given a command this runner does not know, a plugin name it does not take and a plugin the person does not have, when the screen asks for them, then each is refused and only the listing ever reached Claude Code", async () => {
    // when
    const answers = [
      await setupHere({ nonce: "n-1", want: "plugin", op: "reinstall" as never, plugin: "plugin:payments-skills@acme-market" }, where(), { HOME: home }, claude),
      await setupHere({ nonce: "n-2", want: "plugin", op: "disable", plugin: "plugin:payments skills;rm@acme-market" }, where(), { HOME: home }, claude),
      await setupHere({ nonce: "n-3", want: "plugin", op: "disable", plugin: "plugin:other-skills@acme-market" }, where(), { HOME: home, PATH: process.env.PATH }, claude),
    ];

    // then
    expect(answers).toEqual([{ refused: "this runner does not run that command" }, { refused: "that is not a name this runner takes" }, { refused: "that is not a plugin of yours this runner changes" }]);
    expect(readFileSync(ran, "utf8").split("\n").filter(Boolean).every((line) => line.startsWith("plugin list") || line.includes("stream-json"))).toBe(true);
  });

  it("given a plugin the person installed, when the screen turns it off, then Claude Code's own command runs for it at the scope it was installed in, as a list of arguments", async () => {
    // when
    const answer = await setupHere({ nonce: "n-1", want: "plugin", op: "disable", plugin: "plugin:payments-skills@acme-market" }, where(), { HOME: home, PATH: process.env.PATH }, claude);

    // then
    expect(answer).toEqual({ ok: true, command: "claude plugin disable payments-skills@acme-market" });
    expect(readFileSync(ran, "utf8")).toContain("plugin disable payments-skills@acme-market -s user");
  });

  it("given a new skill of the person's own written from the screen, when it is read back and then deleted with the digest it was read with, then the file is there with that text and then gone, and a plugin's skill is not written", async () => {
    // when
    const written = await setupHere({ nonce: "n-1", want: "file", act: "write", source: "yours", kind: "skill", name: "rota-notes", content: "---\nname: rota-notes\ndescription: Keep notes on the rota.\n---\nKeep notes.\n", expectedDigest: null, folder: null }, where(), { HOME: home }, claude);
    const read = await setupHere({ nonce: "n-2", want: "file", act: "read", source: "yours", kind: "skill", name: "rota-notes", folder: null }, where(), { HOME: home }, claude);
    const there = existsSync(join(home, ".claude", "skills", "rota-notes", "SKILL.md"));
    const deleted = await setupHere({ nonce: "n-3", want: "file", act: "delete", source: "yours", kind: "skill", name: "rota-notes", expectedDigest: (read as { digest: string }).digest, folder: null }, where(), { HOME: home }, claude);
    const plugin = await setupHere({ nonce: "n-4", want: "file", act: "write", source: "plugin:payments-skills@acme-market", kind: "skill", name: "add-endpoint", content: "x", expectedDigest: null, folder: null }, where(), { HOME: home }, claude);

    // then
    expect(written).toEqual({ digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(read).toEqual({ content: "---\nname: rota-notes\ndescription: Keep notes on the rota.\n---\nKeep notes.\n", digest: (written as { digest: string }).digest });
    expect([there, deleted, existsSync(join(home, ".claude", "skills", "rota-notes", "SKILL.md"))]).toEqual([true, { deleted: true }, false]);
    expect(plugin).toEqual({ refused: "only your own files and a project folder's are changed from here" });
  });

  it("given a skill of the person's own whose text looks like it holds a key, and a write that breaks the skill's form, when the screen asks to open the one and save the other, then the text does not leave the machine and the write is refused with the reason", async () => {
    // given
    mkdirSync(join(home, ".claude", "skills", "deploy-notes"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "deploy-notes", "SKILL.md"), "---\nname: deploy-notes\n---\nexport AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n");

    // when
    const opened = await setupHere({ nonce: "n-1", want: "file", act: "read", source: "yours", kind: "skill", name: "deploy-notes", folder: null }, where(), { HOME: home }, claude);
    const saved = await setupHere({ nonce: "n-2", want: "file", act: "write", source: "yours", kind: "skill", name: "rota-notes", content: "no front matter here\n", expectedDigest: null, folder: null }, where(), { HOME: home }, claude);

    // then
    expect(opened).toEqual({ refused: "looks-secret" });
    expect(saved).toEqual({ refused: "bad-format", detail: expect.any(String) });
  });
});
