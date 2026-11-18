import { describe, expect, it } from "vitest";
import { entriesOf } from "./handbook-list";
import { flipItem, NOTHING_OFF } from "./handbook-read";
import type { HandbookSource } from "./handbook-read";
import { didNotLoad, stateOf } from "./TaskUsed";

const yours: HandbookSource = { id: "yours", kind: "yours", name: "Yours", enabled: true, skills: [{ name: "release-notes" }, { name: "changelog" }], commands: [], mcpServers: [{ name: "jira" }], hooks: [], claudeMd: true };
const used = { skills: [{ name: "release-notes", source: "yours", sourceLabel: "Yours" }], mcpServers: [] };

describe("the state word a row reads on the task page", () => {
  it("given a called skill, an uncalled server and CLAUDE.md, when read, then they are Used, Loaded and Loaded", () => {
    // when
    const words = entriesOf([yours], NOTHING_OFF, "readonly").map((e) => [e.name, stateOf(e, used).word]);

    // then
    expect(words).toEqual([["release-notes", "Used"], ["changelog", "Loaded"], ["jira", "Loaded"], ["CLAUDE.md", "Loaded"]]);
  });

  it("given a skill turned off for the task that the agent called anyway, when read, then it is said in the danger tone", () => {
    // given
    const off = flipItem(NOTHING_OFF, "skills", "yours", "release-notes");

    // when
    const state = stateOf(entriesOf([yours], off, "readonly").find((e) => e.name === "release-notes")!, used);

    // then
    expect(state).toEqual({ word: "Loaded, though off", danger: true });
  });

  it("given a server turned off and not called, when read, then it is off for this task", () => {
    // given
    const off = flipItem(NOTHING_OFF, "mcpServers", "yours", "jira");

    // when
    const state = stateOf(entriesOf([yours], off, "readonly").find((e) => e.name === "jira")!, used);

    // then
    expect(state).toEqual({ word: "Off for this task", danger: false });
  });
});

describe("what the agent reported against what the setup says", () => {
  it("given a plugin and a server on that the agent did not report as loaded, when compared, then each is named once", () => {
    // given
    const plugin: HandbookSource = { id: "plugin:payments-skills@payments-market", kind: "plugin", name: "payments-skills", version: "1.4.0", enabled: true, skills: [{ name: "add-endpoint" }], commands: [], mcpServers: [], hooks: [] };

    // when
    const missing = didNotLoad([yours, plugin], NOTHING_OFF, { plugins: [], skills: null, mcpServers: [{ name: "jira", state: "failed" }] });

    // then
    expect(missing).toEqual(["payments-skills", "jira"]);
  });

  it("given a kind the agent did not report, when compared, then nothing is said of it", () => {
    // when
    const missing = didNotLoad([yours], NOTHING_OFF, { plugins: null, skills: null, mcpServers: null });

    // then
    expect(missing).toEqual([]);
  });
});

describe("off by the default and off for the task", () => {
  it("given a server off in the default and a skill this task turned off, when read, then the first is Off and the second Off for this task", () => {
    // given
    const defaults = flipItem(NOTHING_OFF, "mcpServers", "yours", "jira");
    const off = flipItem(defaults, "skills", "yours", "release-notes");
    const byDefault = new Set(entriesOf([yours], defaults, "readonly").filter((e) => !e.on).map((e) => e.key));

    // when
    const rows = entriesOf([yours], off, "readonly");
    const word = (name: string) => stateOf(rows.find((e) => e.name === name)!, undefined, byDefault).word;

    // then
    expect([word("jira"), word("release-notes")]).toEqual(["Off", "Off for this task"]);
  });
});
