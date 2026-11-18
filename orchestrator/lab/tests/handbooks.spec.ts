import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { personsRepository, soloSession } from "../solo.js";
import { labDir } from "../state.js";

/**
 * What a person's own Claude Code holds, read by their orchestrator and shown by source: their own
 * skill and a skill of the opened folder are listed under their sources, a skill opens to its text, and
 * a value kept in a server's environment is named nowhere in what is read. The home is the clean machine's.
 */
const stamp = (what: string) => join(labDir(), "handbooks", `${what}-${Date.now().toString(36)}`);
const SECRET = "lab-secret-value-1234567890";

interface Sources {
  available: boolean;
  sources?: { id: string; kind: string; skills?: { name: string }[] }[];
}

test("given a skill of the person's own and one of the folder's, when the orchestrator reads their handbooks, then each is listed under its source, opens to its text, and no environment value is in what was read", async ({ page }) => {
  test.setTimeout(300_000);
  // given
  const solo = await soloSession(page, stamp("sources"));
  try {
    const claude = join(solo.machine.home, ".claude");
    mkdirSync(join(claude, "skills", "review-checklist"), { recursive: true });
    writeFileSync(join(claude, "skills", "review-checklist", "SKILL.md"), "---\nname: review-checklist\ndescription: Use when reviewing a change\n---\n\nRead the diff before the description.\n");
    writeFileSync(join(claude, "settings.json"), JSON.stringify({ mcpServers: { ledger: { command: "ledger-mcp", env: { LEDGER_TOKEN: SECRET } } } }));
    const repo = personsRepository(solo.machine);
    mkdirSync(join(repo, ".claude", "skills", "add-endpoint"), { recursive: true });
    writeFileSync(join(repo, ".claude", "skills", "add-endpoint", "SKILL.md"), "---\nname: add-endpoint\ndescription: Use when adding an endpoint\n---\n\nAdd the route, then its test.\n");
    await solo.call("POST", "/api/projects", { path: repo });

    // when
    const read = await solo.call<Sources>("GET", `/api/handbook/sources?folder=${encodeURIComponent(repo)}`);

    // then
    expect(read.available).toBe(true);
    const names = (read.sources ?? []).flatMap((s) => (s.skills ?? []).map((k) => `${s.kind}:${k.name}`));
    expect(names).toEqual(expect.arrayContaining(["yours:review-checklist", "folder:add-endpoint"]));
    expect(JSON.stringify(read)).not.toContain(SECRET);
    const own = read.sources!.find((s) => (s.skills ?? []).some((k) => k.name === "review-checklist"))!;
    const text = await solo.call<{ content: string }>("GET", `/api/handbook/skill?source=${encodeURIComponent(own.id)}&name=review-checklist`);
    expect(text.content).toContain("Read the diff before the description.");
  } finally {
    await solo.stop();
  }
});
