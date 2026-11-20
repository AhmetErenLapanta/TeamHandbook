import { describe, expect, it } from "vitest";
import { changesBetween, entriesOf, flipEntry, handbookLabel, skillBody, summaryOf, usedSaid } from "./handbook-list";
import { flipItem, flipSource, NOTHING_OFF } from "./handbook-read";
import type { HandbookSource } from "./handbook-read";

const payments: HandbookSource = { id: "plugin:payments-skills@payments-market", kind: "plugin", name: "payments-skills", version: "1.4.0", enabled: true, skills: [{ name: "add-endpoint", context: { tokens: 900, percent: 1 } }], commands: [{ name: "deploy" }], mcpServers: [{ name: "ledger" }], hooks: [{ name: "PreToolUse" }] };
const yours: HandbookSource = { id: "yours", kind: "yours", name: "Yours", enabled: true, skills: [{ name: "release-notes", context: { tokens: 600, percent: 1 } }], commands: [{ name: "ship" }], mcpServers: [{ name: "jira" }], hooks: [{ name: "Stop" }], claudeMd: true };
const folder: HandbookSource = { id: "folder:/home/ada/work/payments-api", kind: "folder", name: "payments-api", enabled: true, skills: [{ name: "release-notes" }], commands: [], mcpServers: [], hooks: [] };

const row = (level: "default" | "task", name: string, sources = [payments, yours]) => entriesOf(sources, NOTHING_OFF, level).find((e) => e.name === name)!;

describe("which rows have a switch", () => {
  it.each(["default", "task"] as const)("given the %s level, when the rows are built, then own items and a plugin's skill switch, and a plugin's server, command and every hook say why not", (level) => {
    // then
    expect(["release-notes", "/ship", "jira", "add-endpoint"].map((n) => row(level, n).switchable)).toEqual([true, true, true, true]);
    expect(row(level, "ledger")).toMatchObject({ switchable: false, whyNot: "It comes with its plugin; turn the plugin off." });
    expect(row(level, "/deploy")).toMatchObject({ switchable: false, whyNot: "It comes with its plugin; turn the plugin off." });
    expect(row(level, "PreToolUse")).toMatchObject({ switchable: false, whyNot: "Claude Code does not leave out one hook; turn off the plugin it comes with." });
    expect(row(level, "Stop")).toMatchObject({ switchable: false, whyNot: "Claude Code runs your own hooks in every session." });
  });

  it("given Team, when an own skill and a plugin's skill are off, then each says what that means for the terminal", () => {
    // given
    const off = flipItem(flipItem(NOTHING_OFF, "skills", "yours", "release-notes"), "skills", payments.id, "add-endpoint");

    // when
    const rows = entriesOf([payments, yours], off, "default");

    // then
    expect(rows.find((e) => e.name === "release-notes")).toMatchObject({ on: false, offNote: "Off for agents started here. Your terminal still has it." });
    expect(rows.find((e) => e.name === "add-endpoint")).toMatchObject({ on: false, offNote: "Off for agents started here: the agent cannot call it; its name still shows." });
  });

  it("given a skill of Yours and one of This folder that share a name, when the rows are built, then neither switches alone; a plugin's skill of the same name still does", () => {
    // when
    const rows = entriesOf([payments, yours, folder], NOTHING_OFF, "task").filter((e) => e.name === "release-notes");
    const plugin = entriesOf([{ ...payments, skills: [{ name: "release-notes" }] }, yours], NOTHING_OFF, "task").filter((e) => e.name === "release-notes");

    // then
    expect(rows.map((e) => [e.source.kind, e.switchable])).toEqual([["yours", false], ["folder", false]]);
    expect(rows[0]!.whyNot).toBe("Two skills are named release-notes; one cannot be left out without the other.");
    expect(plugin.map((e) => e.switchable)).toEqual([true, true]);
  });

  it("given two skills of the same name in Yours and This folder, a skill and a command of Yours sharing a name, a command of the folder sharing one with Yours, and a plugin's skill of a taken name, when the rows are built, then each own row says which the agent is handed first, or that it is not known, and the plugin's says nothing", () => {
    // given
    const own: HandbookSource = { ...yours, skills: [{ name: "release-notes" }, { name: "ship" }], commands: [{ name: "ship" }, { name: "deploy" }] };
    const here: HandbookSource = { ...folder, commands: [{ name: "deploy" }] };
    const plugin: HandbookSource = { ...payments, skills: [{ name: "release-notes" }] };

    // when
    const rows = entriesOf([plugin, own, here], NOTHING_OFF, "default");
    const clashOf = (source: string, name: string) => rows.find((e) => e.source.id === source && e.name === name)!.clash;

    // then
    expect([clashOf("yours", "release-notes"), clashOf(folder.id, "release-notes")]).toEqual(["Two skills are named release-notes: yours is listed first to the agent, this folder's after it.", "Two skills are named release-notes: yours is listed first to the agent, this folder's after it."]);
    expect([clashOf("yours", "ship"), clashOf("yours", "/ship")]).toEqual(["A skill and a command are named ship: the skill is listed first to the agent, the command after it.", "A skill and a command are named ship: the skill is listed first to the agent, the command after it."]);
    expect([clashOf("yours", "/deploy"), clashOf(folder.id, "/deploy")]).toEqual(["Two commands are named /deploy, in yours and this folder; which one an agent gets is not known.", "Two commands are named /deploy, in yours and this folder; which one an agent gets is not known."]);
    expect(clashOf(plugin.id, "release-notes")).toBeUndefined();
  });
});

describe("the summary and the changes from the default", () => {
  it("given a measured skill and an unmeasured server, when summed, then only what is measured counts and the servers say so", () => {
    // when
    const summary = summaryOf([payments, yours], NOTHING_OFF, entriesOf([payments, yours], NOTHING_OFF, "task"));

    // then
    expect(summary).toEqual({ text: "2 handbooks, 9 of 9 on, about 1.5k tokens in every task", heavy: false });
  });

  it("given a default with a skill off, when a task turns it on and a plugin off, then two changes are counted and flipping back counts none", () => {
    // given
    const defaults = flipItem(NOTHING_OFF, "skills", "yours", "release-notes");

    // when
    const changed = flipSource(flipEntry(defaults, row("task", "release-notes")), payments.id);
    const back = flipSource(flipEntry(changed, row("task", "release-notes")), payments.id);

    // then
    expect([changesBetween([payments, yours], changed, defaults), changesBetween([payments, yours], back, defaults)]).toEqual([2, 0]);
  });

  it("given Yours and a plugin listed in any order, when the rows are built, then Yours comes first", () => {
    // when
    const kinds = entriesOf([payments, yours], NOTHING_OFF, "task").map((e) => e.source.kind);

    // then
    expect(kinds.indexOf("yours")).toBeLessThan(kinds.indexOf("plugin"));
  });

  it("given handbooks of each kind, when they are labelled, then every screen names them the same way", () => {
    // then
    expect([handbookLabel(yours), handbookLabel(payments), handbookLabel(folder), handbookLabel({ kind: "team-repo", name: "payments-skills" })]).toEqual(["Yours", "payments-skills 1.4.0", "this folder (payments-api)", "the team's payments-skills"]);
  });
});

describe("what a row says of its use", () => {
  it("given an item used in tasks and one used in none, when the rows say it, then the first says how many and the second says it was not used in the window", () => {
    // then
    expect(usedSaid({ tasks: 1, lastAt: null })).toBe("Used in 1 task.");
    expect(usedSaid({ tasks: 0, lastAt: null })).toBe("Not used in 30 days.");
  });
});

describe("what a skill row shows of the skill and of its use", () => {
  it("given a SKILL.md with front matter and one without, when the body is taken, then the front matter is gone and a text without it is as it was", () => {
    // when
    const withFront = skillBody("---\nname: add-endpoint\ndescription: >-\n  Add one.\n---\n\n# Steps\nDo it.\n");
    const plain = skillBody("# Steps\nDo it.\n");

    // then
    expect([withFront, plain]).toEqual(["# Steps\nDo it.\n", "# Steps\nDo it.\n"]);
  });
});

describe("hook rows", () => {
  it("given a hook with a matcher and a command and one with neither, when the rows are built, then the first carries them for its opened row and the second has none to show", () => {
    // given
    const source: HandbookSource = { ...yours, hooks: [{ name: "PostToolUse", commands: ["npm run lint"], matchers: ["Edit|Write"] }, { name: "Stop" }] };

    // when
    const rows = entriesOf([source], NOTHING_OFF, "default").filter((e) => e.kind === "Hook");

    // then
    expect(rows.map((e) => e.hook)).toEqual([{ matchers: ["Edit|Write"], commands: ["npm run lint"] }, { matchers: [], commands: [] }]);
  });
});

describe("the summary line", () => {
  it("given a plugin with a newer version and nothing measured, when summed, then it counts handbooks and what is on, says the update, and says nothing of cost", () => {
    // given
    const plain: HandbookSource = { ...payments, skills: [{ name: "add-endpoint" }], latest: { version: "1.5.0", added: [], changed: [], removed: [], hooks: [], mcpServers: [] } };
    const mine: HandbookSource = { ...yours, skills: [{ name: "release-notes" }] };

    // when
    const summary = summaryOf([plain, mine], NOTHING_OFF, entriesOf([plain, mine], NOTHING_OFF, "default"));

    // then
    expect(summary.text).toBe("2 handbooks, 9 of 9 on, 1 update");
  });

  it("given a handbook turned off, when summed, then what it holds counts in the total and not as on", () => {
    // given
    const off = { ...NOTHING_OFF, sources: [payments.id] };

    // when
    const summary = summaryOf([payments, yours], off, entriesOf([payments, yours], off, "default"));

    // then
    expect(summary.text).toMatch(/^2 handbooks, 5 of 9 on/);
  });
});
