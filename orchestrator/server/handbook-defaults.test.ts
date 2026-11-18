import { describe, expect, it } from "vitest";
import { NOTHING_OFF, handbookNoticed, handbookOff, markHandbookNoticed, noticeKeyOf, parseOff, saveHandbookOff, withNotices } from "./handbook-defaults.js";
import { openSqliteStore } from "./store.js";

describe("what a person keeps off for the agents started here", () => {
  it("given skills, commands and servers, when the list is parsed, then it is kept with repeats dropped, and an odd source id, a path-like name or a wrong shape refuses it whole", () => {
    // when
    const good = parseOff({ skills: [{ source: "yours", name: "triage-notes" }, { source: "yours", name: "triage-notes" }, { source: "plugin:payments-skills@payments-market", name: "add-endpoint" }], commands: [{ source: "yours", name: "standup" }], mcpServers: [{ source: "folder:/work/shop", name: "ledger" }] });
    const badSource = parseOff({ skills: [{ source: "../elsewhere", name: "x" }] });
    const badName = parseOff({ skills: [{ source: "yours", name: "../settings" }] });
    const notObject = parseOff("yours");

    // then
    expect(good).toEqual({ skills: [{ source: "yours", name: "triage-notes" }, { source: "plugin:payments-skills@payments-market", name: "add-endpoint" }], commands: [{ source: "yours", name: "standup" }], mcpServers: [{ source: "folder:/work/shop", name: "ledger" }] });
    expect([badSource, badName, notObject]).toEqual([null, null, null]);
  });

  it("given two people, when one keeps a server off, then it is theirs alone and the other keeps nothing off", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const off = { skills: [], commands: [], mcpServers: [{ source: "yours", name: "ledger" }] };

    // when
    await saveHandbookOff(store, "default", "usr_a", off);

    // then
    expect(await handbookOff(store, "default", "usr_a")).toEqual(off);
    expect(await handbookOff(store, "default", "usr_b")).toEqual(NOTHING_OFF);
  });
});

describe("the one line about a plugin that runs hooks or servers", () => {
  const plugin = (version: string, hooks = 1) => ({ kind: "plugin", name: "docs-kit", marketplace: "payments-market", version, hooks: Array.from({ length: hooks }, () => ({})), mcpServers: [] });

  it("given a plugin that runs a hook, when its line is closed at its version, then that version is noticed and a newer one is not", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const key = noticeKeyOf(plugin("2.0.0"))!;

    // when
    const marked = await markHandbookNoticed(store, "default", "usr_a", key);

    // then
    expect(marked).toBe(true);
    expect((await handbookNoticed(store, "default", "usr_a")).has(key)).toBe(true);
    expect((await handbookNoticed(store, "default", "usr_a")).has(noticeKeyOf(plugin("2.1.0"))!)).toBe(false);
    expect((await handbookNoticed(store, "default", "usr_b")).size).toBe(0);
  });

  it("given a plugin with no hook and no server, a source that is no plugin and a key with a space, when each is asked, then none has a line and the odd key is not written", async () => {
    // given
    const store = openSqliteStore(":memory:");

    // when
    const plain = noticeKeyOf(plugin("1.0.0", 0));
    const yours = noticeKeyOf({ kind: "yours", name: "Yours", hooks: [{}], mcpServers: [] });
    const odd = await markHandbookNoticed(store, "default", "usr_a", "docs kit@market@1.0.0");

    // then
    expect([plain, yours, odd]).toEqual([null, null, false]);
  });

  it("given a plugin with a hook whose line is open, the same plugin closed, one turned off and one running nothing, when the notices are put on, then only the first carries one, with its counts, and every source stays in the list", () => {
    // given
    const fresh = { ...plugin("2.0.0", 2), enabled: true };
    const closed = { ...plugin("1.0.0"), name: "older-kit", enabled: true };
    const off = { ...plugin("3.0.0"), name: "off-kit", enabled: false };
    const quiet = { ...plugin("1.0.0", 0), name: "quiet-kit", enabled: true };

    // when
    const listed = withNotices([fresh, closed, off, quiet], new Set([noticeKeyOf(closed)!]));

    // then
    expect(listed.map((s) => [s.name, s.notice ?? null])).toEqual([["docs-kit", { hooks: 2, mcpServers: 0 }], ["older-kit", null], ["off-kit", null], ["quiet-kit", null]]);
  });
});
